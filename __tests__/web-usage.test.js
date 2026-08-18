import { addUsage, emptyLedger, estimateCost, summarizeRuns } from '../web/usage.js';

describe('usage ledger', () => {
  it('starts empty', () => {
    expect(emptyLedger()).toEqual({});
  });

  it('accumulates tokens per model across events', () => {
    let ledger = emptyLedger();
    ledger = addUsage(ledger, { model: 'claude-haiku-4-5', inputTokens: 100, outputTokens: 20 });
    ledger = addUsage(ledger, { model: 'claude-haiku-4-5', inputTokens: 50, outputTokens: 5, cacheReadTokens: 10 });
    ledger = addUsage(ledger, { model: 'claude-sonnet-5', inputTokens: 1000, outputTokens: 200 });

    expect(ledger).toEqual({
      'claude-haiku-4-5': { calls: 2, inputTokens: 150, outputTokens: 25, cacheReadTokens: 10, cacheWriteTokens: 0 },
      'claude-sonnet-5':  { calls: 1, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }
    });
  });

  it('does not mutate the ledger it was given', () => {
    const before = emptyLedger();
    addUsage(before, { model: 'claude-haiku-4-5', inputTokens: 1, outputTokens: 1 });
    expect(before).toEqual({});
  });
});

describe('estimateCost', () => {
  it('prices a known model from its list rates', () => {
    // Haiku 4.5: $1 / MTok in, $5 / MTok out
    const cost = estimateCost({
      'claude-haiku-4-5': { calls: 1, inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 }
    });
    expect(cost.usd).toBeCloseTo(6, 6);
    expect(cost.byModel['claude-haiku-4-5'].usd).toBeCloseTo(6, 6);
    expect(cost.unpriced).toEqual([]);
  });

  it('prices cache reads at a tenth and cache writes at 1.25x of input', () => {
    const cost = estimateCost({
      'claude-sonnet-5': { calls: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 }
    });
    // Sonnet 5: $3 in → $0.30 read, $3.75 write
    expect(cost.usd).toBeCloseTo(4.05, 6);
  });

  it('matches dated model ids by family prefix', () => {
    const cost = estimateCost({
      'claude-haiku-4-5-20251001': { calls: 1, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    });
    expect(cost.usd).toBeCloseTo(1, 6);
  });

  it('reports unknown models instead of guessing a price', () => {
    const cost = estimateCost({
      'claude-mystery-9': { calls: 3, inputTokens: 500, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }
    });
    expect(cost.usd).toBe(0);
    expect(cost.unpriced).toEqual(['claude-mystery-9']);
    expect(cost.byModel['claude-mystery-9'].usd).toBeNull();
  });
});

describe('summarizeRuns', () => {
  const day = 24 * 60 * 60 * 1000;
  const runs = [
    { id: 'a', kind: 'scrape', startedAt: 10 * day, usage: { 'claude-haiku-4-5': { calls: 1, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } } },
    { id: 'b', kind: 'scrape', startedAt: 40 * day, usage: { 'claude-haiku-4-5': { calls: 2, inputTokens: 2_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } } },
    { id: 'c', kind: 'story', startedAt: 41 * day }   // stories never call Claude
  ];

  it('totals every run and the runs since a cutoff separately', () => {
    const summary = summarizeRuns(runs, { since: 30 * day });

    expect(summary.allTime.usd).toBeCloseTo(3, 6);
    expect(summary.allTime.runs).toBe(2);
    expect(summary.allTime.calls).toBe(3);
    expect(summary.sinceCutoff.usd).toBeCloseTo(2, 6);
    expect(summary.sinceCutoff.runs).toBe(1);
  });

  it('is empty rather than broken when nothing has been recorded', () => {
    const summary = summarizeRuns([], { since: 0 });
    expect(summary.allTime).toMatchObject({ usd: 0, runs: 0, calls: 0 });
    expect(summary.allTime.byModel).toEqual({});
  });
});
