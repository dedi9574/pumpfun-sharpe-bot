// Pump.fun Sharpe Sprint entry: a launch sniper with a rug filter, plus a mint-pacing
// probe so the run clears the 20-distinct-mint guardrail.
// Run by the grader as `node /bot/main.ts`; the strategy lives in strategy.ts, the protocol
// in the vendored SDK shim (vendor/makefun-bot.ts, a copy of the kit's sdk/ts file).

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy } from './strategy.ts';

const strategy = createStrategy();

await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
});
