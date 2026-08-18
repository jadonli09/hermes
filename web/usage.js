// Server-side Claude spend estimate over the run history.
//
// Anthropic exposes no "remaining balance" endpoint, and its usage/cost report
// needs an Admin key that individual accounts cannot create. So the dashboard
// keeps its own ledger: every Claude call the pipeline makes emits a
// `claude:usage` event, the runner folds those into the run's history record,
// and this prices them. The arithmetic itself lives in public/pricing.js so the
// browser can show the same estimate live.
import { emptyLedger, estimateCost, mergeLedgers } from './public/pricing.js';

export { addUsage, emptyLedger, estimateCost } from './public/pricing.js';

function totalRuns(runs) {
  const withUsage = runs.filter(run => run.usage && Object.keys(run.usage).length > 0);
  const ledger = withUsage.reduce((acc, run) => mergeLedgers(acc, run.usage), emptyLedger());
  return { ...estimateCost(ledger), runs: withUsage.length };
}

export function summarizeRuns(runs, { since }) {
  return {
    allTime: totalRuns(runs),
    sinceCutoff: totalRuns(runs.filter(run => (run.startedAt || 0) >= since)),
    since
  };
}
