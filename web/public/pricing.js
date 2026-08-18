// Claude token accounting and list-price estimate.
//
// Shared by the browser (live cost tile during a run) and the server (history
// totals), so this file imports nothing and knows nothing about either.
//
// It is an estimate: list prices lag promotions, and only runs started from the
// dashboard are counted. The Anthropic Console is the source of truth.

// USD per million tokens, keyed by model-id prefix. Longest prefix wins, so a
// dated snapshot like claude-haiku-4-5-20251001 resolves to the family row.
const PRICES = [
  ['claude-fable-5',   { input: 10, output: 50 }],
  ['claude-mythos-5',  { input: 10, output: 50 }],
  ['claude-opus-5',    { input: 5,  output: 25 }],
  ['claude-opus-4',    { input: 5,  output: 25 }],
  ['claude-sonnet-5',  { input: 3,  output: 15 }],
  ['claude-sonnet-4',  { input: 3,  output: 15 }],
  ['claude-haiku-4-5', { input: 1,  output: 5 }]
];

const CACHE_READ_FACTOR = 0.1;
const CACHE_WRITE_FACTOR = 1.25;

const ZERO = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

export function emptyLedger() {
  return {};
}

export function addUsage(ledger, { model, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0 }) {
  const prior = ledger[model] || ZERO;
  return {
    ...ledger,
    [model]: {
      calls: prior.calls + 1,
      inputTokens: prior.inputTokens + inputTokens,
      outputTokens: prior.outputTokens + outputTokens,
      cacheReadTokens: prior.cacheReadTokens + cacheReadTokens,
      cacheWriteTokens: prior.cacheWriteTokens + cacheWriteTokens
    }
  };
}

export function mergeLedgers(a, b) {
  const merged = { ...a };
  for (const [model, usage] of Object.entries(b || {})) {
    const prior = merged[model] || ZERO;
    merged[model] = {
      calls: prior.calls + usage.calls,
      inputTokens: prior.inputTokens + usage.inputTokens,
      outputTokens: prior.outputTokens + usage.outputTokens,
      cacheReadTokens: prior.cacheReadTokens + usage.cacheReadTokens,
      cacheWriteTokens: prior.cacheWriteTokens + usage.cacheWriteTokens
    };
  }
  return merged;
}

function priceFor(model) {
  let best = null;
  for (const [prefix, price] of PRICES) {
    if (model.startsWith(prefix) && (!best || prefix.length > best[0].length)) best = [prefix, price];
  }
  return best ? best[1] : null;
}

export function estimateCost(ledger) {
  const byModel = {};
  const unpriced = [];
  let usd = 0;
  let calls = 0;

  for (const [model, usage] of Object.entries(ledger)) {
    calls += usage.calls;
    const price = priceFor(model);
    if (!price) {
      unpriced.push(model);
      byModel[model] = { ...usage, usd: null };
      continue;
    }

    const modelUsd = (
      usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * price.input * CACHE_READ_FACTOR +
      usage.cacheWriteTokens * price.input * CACHE_WRITE_FACTOR
    ) / 1_000_000;

    byModel[model] = { ...usage, usd: modelUsd };
    usd += modelUsd;
  }

  return { usd, calls, byModel, unpriced };
}
