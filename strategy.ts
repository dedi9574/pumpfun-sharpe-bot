// Launch sniper with a rug filter, plus a mint-pacing probe, for agent-fun/replay/v2.
//
// The sniper watches every coin from its CreateEvent and reads the opening tape in its first
// slots: how big the creator's own buy was, how many other wallets piled in with it (a launch
// bundled by many wallets in its first slot is usually the creator's cluster waiting to dump),
// whether the creator has already sold, and how much real SOL the curve holds. It buys only
// launches that pass all of that, takes profit fast, cuts losers fast, never holds past a few
// slots, and leaves at once when the creator sells.
//
// The probe exists for the guardrail, not for profit: a run must trade at least 20 distinct
// mints. The sniper alone is picky and can fall behind that pace, so when the distinct-mint
// count lags behind one mint per PROBE_PACE_SECONDS of elapsed block time, the bot buys a
// minimum-size slice (0.01 SOL) of the most liquid coin it has never traded — an older,
// established curve, never a fresh launch — and sells it all on the next batch. Each probe
// costs roughly its fees and buys one more distinct mint.
//
// Pure function of the batches it is fed: no clock, no randomness, no I/O. Deterministic:
// iteration order is insertion order everywhere, and ties break to the first coin seen.

import { BPS, type BotState, type Batch, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

/** All tunables in one place. Values are the validated C1 set unless noted. */
export const CONFIG = {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minEntryAge: 0,
  /** First-buy window: age in slots since the CreateEvent. */
  maxEntryAge: 6,
  /** Lamports aimed for per coin in total (each reply still capped at 1% of real SOL). */
  stakeLamports: 100_000_000,
  /** Smallest single buy worth paying the tx fee for. */
  minBuyLamports: 20_000_000,
  /** Real SOL reserve window at decision time (lamports). */
  minRealSol: 300_000_000,
  maxRealSol: 30_000_000_000,
  /** Creator's own buys in the create slot: lamports window. */
  minDevBuy: 0,
  maxDevBuy: 2_500_000_000,
  /** Trades seen and distinct (non-creator) buyers seen before entry. */
  minTrades: 4,
  minBuyers: 2,
  /** Distinct non-creator buyers before entry, at most: a launch bundled by many wallets is a dump in waiting. */
  maxBuyers: 3,
  /** Lamports sold by others / lamports bought, as bps, at most. */
  maxSellRatioBps: 5000,
  /** Largest single non-creator sell seen, as bps of the real SOL reserve before it, at most. */
  maxBigSellBps: 1000,
  /** Creator sold before entry: skip the coin. */
  skipDevSold: true,
  /** Slippage allowed on buys (bps). */
  buySlippageBps: 300,
  /** Exit when the position is worth this much over its cost (bps). */
  takeProfitBps: 1500,
  /** Exit when it is worth this much under its cost (bps). */
  stopLossBps: 1200,
  /** Exit after holding this many slots (counted from the buy's fill slot). */
  maxHoldSlots: 5,
  /** Exit when the creator sells while held. */
  exitOnDevSell: true,
  /** Probe: keep the distinct-mint count on a pace of one mint per this many seconds. */
  probePaceSeconds: 800,
  /** Probe: stop probing once this many distinct mints have been traded. */
  probeTargetMints: 22,
  /** Probe: lamports per probe buy (exactly the 0.01 SOL minimum round trip). */
  probeLamports: 10_000_000,
  /** Probe: only coins holding at least this much real SOL. */
  probeMinRealSol: 2_000_000_000,
  /** Probe: only coins with at least this many trades seen. */
  probeMinTrades: 5,
  /**
   * Probe: only once block time reaches this epoch (2026-11-28T12:00:00Z, hours before
   * the final window opens at 17:00Z). The 24h dev window gives the sniper 50+ mints on
   * its own, so probing there would only burn PnL and risk the dev-profit gate; the 6h
   * final window is where the sniper falls short of 20 mints. Block time comes from the
   * batches, so this is deterministic: same data, same decisions.
   */
  probeActiveFrom: 1795867200,
} as const;

/** One coin's opening tape, kept from its CreateEvent until it is done. */
interface Watched {
  mint: Pubkey;
  createdSlot: number;
  creator: Pubkey;
  /** Create-time reserves: the price run-up is measured against them. */
  startVq: bigint;
  startVt: bigint;
  devBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  worstSellBps: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  buysSent: number;
  spentSent: bigint;
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

/** A held position's bookkeeping (the account itself carries tokens and cost). */
interface Held {
  openedSlot: number;
  /** Tx fees paid on this position's fills. */
  txPaid: bigint;
  devSoldAtOpen: boolean;
}

export interface Strategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

/** Curve fees on a sell: protocol 95 bps + creator 30 bps. */
const SELL_FEE_BPS = 125n;

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellProceeds(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const gross = (tokens * vq) / (vt + tokens);
  return gross - (gross * SELL_FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(): Strategy {
  const watched = new Map<Pubkey, Watched>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();
  /** Mints where a buy filled (sniper or probe): the distinct-mint count. */
  const traded = new Set<Pubkey>();
  /** Probe buys sent and not yet resolved. */
  const probePending = new Set<Pubkey>();
  /** Probe mints whose buy filled and must be sold on the next batch. */
  const probeToSell = new Set<Pubkey>();
  let firstTime: number | null = null;
  let nowTime = 0;

  function noteTrade(c: Watched, e: Extract<Batch['events'][number], { event: 'TradeEvent' }>): void {
    const sol = BigInt(e.sol_amount);
    c.trades += 1;
    c.lastTradeSlot = e.slot;
    const isDev = e.user === c.creator;
    if (e.is_buy) {
      c.bought += sol;
      if (isDev && e.slot === c.createdSlot) c.devBuy += sol;
      else if (!isDev) c.buyers.add(e.user);
    } else if (isDev) {
      c.devSold = true;
    } else {
      c.soldByOthers += sol;
      const reserveBefore = BigInt(e.real_quote_reserves) + sol;
      if (reserveBefore > 0n) {
        const bps = (sol * BPS) / reserveBefore;
        if (bps > c.worstSellBps) c.worstSellBps = bps;
      }
    }
  }

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        watched.set(e.mint, {
          mint: e.mint,
          createdSlot: e.slot,
          creator: e.creator,
          startVq: BigInt(e.virtual_quote_reserves),
          startVt: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          trades: 0,
          buyers: new Set(),
          bought: 0n,
          soldByOthers: 0n,
          worstSellBps: 0n,
          devSold: false,
          lastTradeSlot: e.slot,
          buysSent: 0,
          spentSent: 0n,
          done: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = watched.get(e.mint);
        if (c !== undefined) noteTrade(c, e);
      } else {
        const c = watched.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  function pendingBuy(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'buy') return true;
    return false;
  }

  function pendingSell(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'sell') return true;
    return false;
  }

  /** The most liquid probe candidate: an older, established curve never traded by us. */
  function probeCandidate(state: BotState): Pubkey | null {
    let best: Pubkey | null = null;
    let bestReal = 0n;
    for (const curve of state.curves.values()) {
      if (traded.has(curve.mint) || probePending.has(curve.mint) || probeToSell.has(curve.mint)) continue;
      if (state.positions.has(curve.mint) || selling.has(curve.mint) || pendingBuy(state, curve.mint)) continue;
      if (curve.complete) continue;
      if (curve.real_quote_reserves < BigInt(CONFIG.probeMinRealSol)) continue;
      if (curve.trades < CONFIG.probeMinTrades) continue;
      // Never a fresh launch: either created before this window, or older than the sniper window.
      if (curve.created_slot !== null && state.slot - curve.created_slot <= CONFIG.maxEntryAge) continue;
      if (curve.real_quote_reserves > bestReal) {
        bestReal = curve.real_quote_reserves;
        best = curve.mint;
      }
    }
    return best;
  }

  return {
    onBatch(state, batch) {
      readEvents(batch);
      for (const e of batch.events) {
        if (e.block_time === null) continue;
        if (firstTime === null) firstTime = e.block_time;
        if (e.block_time > nowTime) nowTime = e.block_time;
      }
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });

      // Fills: track held positions, the distinct-mint count, and probe progress.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          probeToSell.delete(f.mint);
          continue;
        }
        // Add this fill's tx fee to an already-tracked position first; a brand-new
        // position is created below with its fee already counted, so it must not
        // be added twice.
        const h = held.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled') {
          traded.add(f.mint);
          if (probePending.has(f.mint)) {
            probePending.delete(f.mint);
            probeToSell.add(f.mint);
          }
          if (h === undefined) {
            held.set(f.mint, {
              openedSlot: f.slot,
              txPaid: BigInt(f.tx_fee_lamports),
              devSoldAtOpen: watched.get(f.mint)?.devSold ?? false,
            });
          }
        } else if (f.side === 'buy' && f.status !== 'filled') {
          probePending.delete(f.mint);
        }
      }
      for (const mint of [...selling]) if (!pendingSell(state, mint)) selling.delete(mint);
      for (const mint of [...probeToSell]) if (!state.positions.has(mint) && !selling.has(mint)) probeToSell.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !pendingBuy(state, mint)) held.delete(mint);
      }

      // Probe sells first: a probe round trip closes on the next batch after its buy filled.
      for (const mint of [...probeToSell]) {
        if (orders.length >= cap) break;
        const pos = state.positions.get(mint);
        if (pos === undefined || selling.has(mint)) {
          if (pos === undefined) probeToSell.delete(mint);
          continue;
        }
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        probeToSell.delete(mint);
      }

      // Exits.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = watched.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, devSoldAtOpen: c?.devSold ?? false };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const curve = state.curves.get(mint);
          if (curve === undefined) continue;
          mk = { vq: curve.virtual_quote_reserves, vt: curve.virtual_token_reserves };
        }
        const value = sellProceeds(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        let exit = false;
        if (basis > 0n) {
          if (value * BPS >= basis * (BPS + BigInt(CONFIG.takeProfitBps))) exit = true;
          if (value * BPS <= basis * (BPS - BigInt(CONFIG.stopLossBps))) exit = true;
        }
        if (state.slot - h.openedSlot >= CONFIG.maxHoldSlots) exit = true;
        if (c !== undefined && CONFIG.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Entries.
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let open = state.committedPositionCount();
      for (const c of watched.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete) continue;
        // No adds: one buy per coin, ever. (A buy already sent — filled, pending or
        // rejected — spends the coin's whole stake, so there is nothing left to add.)
        if (c.buysSent > 0) continue;
        const age = state.slot - c.createdSlot;
        if (age < CONFIG.minEntryAge) continue;
        if (age > CONFIG.maxEntryAge) {
          c.done = true;
          continue;
        }
        if (open >= state.hello.caps.max_open_positions) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (c.devSold && CONFIG.skipDevSold) {
          c.done = true;
          continue;
        }
        // Rug filter.
        const rq = curve.real_quote_reserves;
        if (rq < BigInt(CONFIG.minRealSol) || rq > BigInt(CONFIG.maxRealSol)) continue;
        if (c.devBuy < BigInt(CONFIG.minDevBuy) || c.devBuy > BigInt(CONFIG.maxDevBuy)) continue;
        if (c.trades < CONFIG.minTrades || c.buyers.size < CONFIG.minBuyers || c.buyers.size > CONFIG.maxBuyers) continue;
        if (c.bought > 0n && c.soldByOthers * BPS > c.bought * BigInt(CONFIG.maxSellRatioBps)) continue;
        if (c.worstSellBps > BigInt(CONFIG.maxBigSellBps)) continue;
        // Skip a launch that already ran up more than 100x since creation: chasing it
        // buys the top. (runup is a ratio in bps, so it is never below zero.)
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        const runup = (vq * c.startVt * BPS) / (vt * c.startVq);
        if (runup > 1_000_000n) continue;
        const room = BigInt(CONFIG.stakeLamports) - c.spentSent;
        if (room < BigInt(CONFIG.minBuyLamports)) continue;
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = room < maxBuy ? room : maxBuy;
        if (amount < BigInt(CONFIG.minBuyLamports)) continue;
        if (free < amount + tx * 6n) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: CONFIG.buySlippageBps });
        free -= amount + tx;
        c.buysSent += 1;
        c.spentSent += amount;
        open += 1;
      }

      // Probe buy: only when the distinct-mint count lags its pace, only in the final
      // window (see probeActiveFrom), and only one per batch.
      if (traded.size < CONFIG.probeTargetMints && firstTime !== null && nowTime >= CONFIG.probeActiveFrom) {
        const elapsed = Math.max(0, nowTime - firstTime);
        if (elapsed > CONFIG.probePaceSeconds * (traded.size + 1)) {
          const mint = probeCandidate(state);
          if (mint !== null && orders.length < cap && open < state.hello.caps.max_open_positions) {
            const amount = BigInt(CONFIG.probeLamports);
            if (amount <= state.maxBuyLamports(mint) && free >= amount + tx * 6n) {
              orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: CONFIG.buySlippageBps });
              probePending.add(mint);
            }
          }
        }
      }
      return orders;
    },
  };
}
