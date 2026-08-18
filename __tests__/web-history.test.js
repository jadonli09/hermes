import fs from 'fs';
import os from 'os';
import path from 'path';
import { appendRecord, readRuns, runEventsPath } from '../web/history.js';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-history-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('readRuns', () => {
  it('returns an empty list when nothing has run yet', () => {
    expect(readRuns(dir)).toEqual([]);
  });

  it('folds the start and end records of one run together', () => {
    appendRecord(dir, { id: 'r1', kind: 'scrape', status: 'running', startedAt: 1000 });
    appendRecord(dir, { id: 'r1', status: 'ok', endedAt: 5000, exitCode: 0, summary: { clubsProcessed: 85 } });

    const runs = readRuns(dir);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: 'r1', kind: 'scrape', status: 'ok', startedAt: 1000, endedAt: 5000, exitCode: 0
    });
    expect(runs[0].summary.clubsProcessed).toBe(85);
  });

  it('orders newest first and honors limit', () => {
    for (const [id, startedAt] of [['a', 1], ['b', 2], ['c', 3]]) {
      appendRecord(dir, { id, kind: 'scrape', status: 'ok', startedAt });
    }
    expect(readRuns(dir, { limit: 2 }).map(r => r.id)).toEqual(['c', 'b']);
  });

  it('reports a stale running record as interrupted', () => {
    // The server was killed mid-run, so nothing ever wrote an end record. The
    // status is derived at read time rather than repaired by a write, because a
    // repair write would itself be lost to the next crash.
    appendRecord(dir, { id: 'r1', kind: 'scrape', status: 'running', startedAt: 1000 });

    expect(readRuns(dir)[0].status).toBe('interrupted');
  });

  it('leaves the currently active run alone', () => {
    appendRecord(dir, { id: 'r1', kind: 'scrape', status: 'running', startedAt: 1000 });

    expect(readRuns(dir, { activeRunId: 'r1' })[0].status).toBe('running');
  });

  it('skips a corrupt line instead of failing the whole read', () => {
    appendRecord(dir, { id: 'r1', kind: 'scrape', status: 'ok', startedAt: 1 });
    fs.appendFileSync(path.join(dir, 'runs.jsonl'), 'this is not json\n');
    appendRecord(dir, { id: 'r2', kind: 'scrape', status: 'ok', startedAt: 2 });

    expect(readRuns(dir).map(r => r.id)).toEqual(['r2', 'r1']);
  });

  it('ignores a record with no id', () => {
    appendRecord(dir, { kind: 'scrape', status: 'ok', startedAt: 1 });
    expect(readRuns(dir)).toEqual([]);
  });
});

describe('runEventsPath', () => {
  it('places per-run event logs under runs/', () => {
    expect(runEventsPath(dir, 'r1')).toBe(path.join(dir, 'runs', 'r1.jsonl'));
  });

  it('refuses a run id that would escape the directory', () => {
    expect(() => runEventsPath(dir, '../../etc/passwd')).toThrow(/invalid run id/i);
    expect(() => runEventsPath(dir, 'a/b')).toThrow(/invalid run id/i);
  });
});

describe('backfillRuns', () => {
  const writeEvents = (id, events) => {
    const file = runEventsPath(dir, id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, events.map((e, i) => JSON.stringify({ ...e, seq: i + 1 })).join('\n') + '\n');
  };

  it('recovers summary, story, and usage for finished runs recorded before they were persisted', async () => {
    const { backfillRuns } = await import('../web/history.js');

    appendRecord(dir, { id: 'old', kind: 'scrape', status: 'running', startedAt: 1000 });
    appendRecord(dir, { id: 'old', status: 'ok', endedAt: 5000 });
    writeEvents('old', [
      { t: 'run:start', runId: 'old' },
      { t: 'claude:usage', model: 'claude-haiku-4-5', inputTokens: 10, outputTokens: 2 },
      { t: 'summary', summary: { clubsProcessed: 3 } },
      { t: 'story:done', date: '2026-08-13', pages: 1, files: ['story-2026-08-13-p1.png'] },
      { t: 'run:end', status: 'ok' }
    ]);

    const patched = backfillRuns(dir, readRuns(dir));

    expect(patched[0].summary).toEqual({ clubsProcessed: 3 });
    expect(patched[0].story).toEqual({ date: '2026-08-13', pages: 1 });
    expect(patched[0].usage['claude-haiku-4-5']).toMatchObject({ calls: 1, inputTokens: 10 });

    // Persisted, so the event file is only parsed once.
    fs.rmSync(runEventsPath(dir, 'old'));
    expect(readRuns(dir)[0].summary).toEqual({ clubsProcessed: 3 });
  });

  it('marks a run it could not recover so it is not re-read every request', async () => {
    const { backfillRuns } = await import('../web/history.js');
    appendRecord(dir, { id: 'lost', kind: 'scrape', status: 'ok', startedAt: 1000, endedAt: 2000 });

    backfillRuns(dir, readRuns(dir));
    const [run] = readRuns(dir);

    expect(run.summary).toBeUndefined();
    expect(run.backfilled).toBe(true);
    expect(backfillRuns(dir, [run])).toEqual([run]);   // second pass is a no-op
  });

  it('leaves running and already-complete records alone', async () => {
    const { backfillRuns } = await import('../web/history.js');
    appendRecord(dir, { id: 'live', kind: 'scrape', status: 'running', startedAt: 1000 });
    appendRecord(dir, { id: 'done', kind: 'scrape', status: 'ok', startedAt: 500, endedAt: 900, summary: { clubsProcessed: 1 } });

    const before = readRuns(dir, { activeRunId: 'live' });
    expect(backfillRuns(dir, before)).toEqual(before);
    expect(fs.readFileSync(path.join(dir, 'runs.jsonl'), 'utf-8').split('\n').filter(Boolean)).toHaveLength(2);
  });
});
