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
