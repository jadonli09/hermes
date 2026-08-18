import { initialState, reduce, reduceAll } from '../web/public/state.js';

const run = (...events) => reduceAll(initialState(), events);

describe('reduce', () => {
  it('starts idle', () => {
    expect(initialState()).toMatchObject({ status: 'idle', clubsDone: 0, clubsTotal: 0 });
  });

  it('tracks a run from start to finish', () => {
    const state = run(
      { t: 'run:start', runId: 'r1', kind: 'scrape', seq: 1 },
      { t: 'run:config', accounts: 85, startDate: '2026-08-05', seq: 2 },
      { t: 'phase', name: 'process', seq: 3 },
      { t: 'club:start', index: 1, total: 85, account: 'msjbio', seq: 4 },
      { t: 'club:done', index: 1, total: 85, account: 'msjbio', postsFound: 3, eventsExtracted: 2, seq: 5 }
    );

    expect(state).toMatchObject({
      runId: 'r1', kind: 'scrape', status: 'running', phase: 'process',
      accounts: 85, clubsTotal: 85, clubsDone: 1, postsFound: 3, eventsExtracted: 2,
      lastSeq: 5
    });
  });

  it('accumulates counts across clubs', () => {
    const state = run(
      { t: 'run:start', runId: 'r1', kind: 'scrape', seq: 1 },
      { t: 'club:done', index: 1, total: 2, account: 'a', postsFound: 3, eventsExtracted: 2, seq: 2 },
      { t: 'club:done', index: 2, total: 2, account: 'b', postsFound: 4, eventsExtracted: 1, seq: 3 }
    );

    expect(state).toMatchObject({ clubsDone: 2, postsFound: 7, eventsExtracted: 3 });
  });

  it('collects club errors without stopping the run', () => {
    const state = run(
      { t: 'run:start', runId: 'r1', kind: 'scrape', seq: 1 },
      { t: 'club:error', index: 1, total: 2, account: 'msjbio', message: 'Apify 402', seq: 2 },
      { t: 'club:done', index: 2, total: 2, account: 'msjchemclub', postsFound: 1, eventsExtracted: 1, seq: 3 }
    );

    expect(state.errors).toEqual([{ account: 'msjbio', message: 'Apify 402' }]);
    // An errored club is still a club accounted for, or the bar stalls at 84/85
    // on a run that actually finished.
    expect(state.clubsDone).toBe(2);
    expect(state.status).toBe('running');
  });

  it('records the final status and summary', () => {
    const state = run(
      { t: 'run:start', runId: 'r1', kind: 'scrape', seq: 1 },
      { t: 'sheet:write', updated: 2, appended: 5, skipped: 1, seq: 2 },
      { t: 'summary', summary: { clubsProcessed: 85, totalApiCallsMade: 12 }, seq: 3 },
      { t: 'run:end', ok: true, status: 'ok', exitCode: 0, durationMs: 61000, seq: 4 }
    );

    expect(state.status).toBe('ok');
    expect(state.sheet).toEqual({ updated: 2, appended: 5, skipped: 1 });
    expect(state.summary.totalApiCallsMade).toBe(12);
    expect(state.durationMs).toBe(61000);
  });

  it('marks a failed run failed and keeps the stderr tail', () => {
    const state = run(
      { t: 'run:start', runId: 'r1', kind: 'scrape', seq: 1 },
      { t: 'run:end', ok: false, status: 'failed', exitCode: 1, stderr: 'out of credit', seq: 2 }
    );

    expect(state).toMatchObject({ status: 'failed', exitCode: 1, stderr: 'out of credit' });
  });

  it('marks a cancelled run cancelled', () => {
    const state = run(
      { t: 'run:start', runId: 'r1', kind: 'scrape', seq: 1 },
      { t: 'run:end', ok: false, status: 'cancelled', exitCode: null, seq: 2 }
    );

    expect(state.status).toBe('cancelled');
  });

  it('caps the log so a long run cannot grow without bound', () => {
    const events = Array.from({ length: 600 }, (_, i) => ({
      t: 'log', level: 'info', message: `line ${i}`, seq: i + 1
    }));

    const state = reduceAll(initialState(), events);
    expect(state.log).toHaveLength(500);
    expect(state.log.at(-1).message).toBe('line 599');
  });

  it('captures story results', () => {
    const state = run(
      { t: 'run:start', runId: 'r1', kind: 'story', seq: 1 },
      { t: 'story:done', date: '2026-08-12', pages: 2, files: ['story-2026-08-12-p1.png', 'story-2026-08-12-p2.png'], seq: 2 }
    );

    expect(state.story).toEqual({
      date: '2026-08-12', pages: 2, files: ['story-2026-08-12-p1.png', 'story-2026-08-12-p2.png']
    });
  });

  it('resets prior state when a new run starts', () => {
    const state = run(
      { t: 'run:start', runId: 'r1', kind: 'scrape', seq: 1 },
      { t: 'club:done', index: 1, total: 1, account: 'a', postsFound: 9, eventsExtracted: 9, seq: 2 },
      { t: 'run:end', ok: true, status: 'ok', seq: 3 },
      { t: 'run:start', runId: 'r2', kind: 'scrape', seq: 4 }
    );

    expect(state).toMatchObject({ runId: 'r2', status: 'running', postsFound: 0, eventsExtracted: 0 });
    expect(state.errors).toEqual([]);
  });

  it('ignores an event it does not recognize', () => {
    const before = run({ t: 'run:start', runId: 'r1', kind: 'scrape', seq: 1 });
    const after = reduce(before, { t: 'something:new', seq: 2 });

    expect(after).toMatchObject({ runId: 'r1', status: 'running', lastSeq: 2 });
  });

  it('does not mutate the state it is given', () => {
    const before = run({ t: 'run:start', runId: 'r1', kind: 'scrape', seq: 1 });
    const snapshot = JSON.stringify(before);

    reduce(before, { t: 'club:done', index: 1, total: 1, account: 'x', postsFound: 1, eventsExtracted: 1, seq: 2 });
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe('claude usage', () => {
  it('starts with no usage recorded', () => {
    expect(initialState().usage).toEqual({});
  });

  it('accumulates token buckets per model as calls are reported', () => {
    const state = run(
      { t: 'run:start', runId: 'r1', kind: 'scrape', seq: 1 },
      { t: 'claude:usage', model: 'claude-haiku-4-5', inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, seq: 2 },
      { t: 'claude:usage', model: 'claude-haiku-4-5', inputTokens: 50, outputTokens: 5, cacheReadTokens: 8, cacheWriteTokens: 0, seq: 3 },
      { t: 'claude:usage', model: 'claude-sonnet-5', inputTokens: 900, outputTokens: 90, cacheReadTokens: 0, cacheWriteTokens: 0, seq: 4 }
    );

    expect(state.usage).toEqual({
      'claude-haiku-4-5': { calls: 2, inputTokens: 150, outputTokens: 15, cacheReadTokens: 8, cacheWriteTokens: 0 },
      'claude-sonnet-5':  { calls: 1, inputTokens: 900, outputTokens: 90, cacheReadTokens: 0, cacheWriteTokens: 0 }
    });
  });

  it('resets usage when a new run starts', () => {
    const state = run(
      { t: 'run:start', runId: 'r1', kind: 'scrape', seq: 1 },
      { t: 'claude:usage', model: 'claude-haiku-4-5', inputTokens: 100, outputTokens: 10, seq: 2 },
      { t: 'run:start', runId: 'r2', kind: 'scrape', seq: 3 }
    );
    expect(state.usage).toEqual({});
  });
});

describe('roll call', () => {
  it('remembers which account positions succeeded and which failed', () => {
    const state = run(
      { t: 'run:start', runId: 'r1', kind: 'scrape', seq: 1 },
      { t: 'club:done', index: 1, total: 3, account: 'a', postsFound: 1, eventsExtracted: 0, seq: 2 },
      { t: 'club:error', index: 2, total: 3, account: 'b', message: 'boom', seq: 3 },
      { t: 'club:start', index: 3, total: 3, account: 'c', seq: 4 }
    );

    expect(state.rollcall).toEqual({ 1: 'done', 2: 'error' });
    expect(state.current).toBe('c');
  });

  it('starts empty and clears on a new run', () => {
    expect(initialState().rollcall).toEqual({});
    const state = run(
      { t: 'run:start', runId: 'r1', kind: 'scrape', seq: 1 },
      { t: 'club:done', index: 1, total: 1, account: 'a', seq: 2 },
      { t: 'run:start', runId: 'r2', kind: 'scrape', seq: 3 }
    );
    expect(state.rollcall).toEqual({});
  });
});
