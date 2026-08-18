// runs.jsonl is append-only: a start record when a run begins, an end record
// when it finishes, folded by id at read time. Appending twice beats rewriting
// one record in place, because a crash between the read and the write would
// otherwise lose the run entirely.
import fs from 'fs';
import path from 'path';
import { addUsage } from './public/pricing.js';

const RUNS_FILE = 'runs.jsonl';
const VALID_RUN_ID = /^[A-Za-z0-9_-]+$/;

export function appendRecord(dir, record) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, RUNS_FILE), JSON.stringify(record) + '\n');
}

export function runEventsPath(dir, runId) {
  if (!VALID_RUN_ID.test(runId)) {
    throw new Error(`Invalid run id: ${runId}`);
  }
  return path.join(dir, 'runs', `${runId}.jsonl`);
}

export function readRuns(dir, { limit = 50, activeRunId = null } = {}) {
  const file = path.join(dir, RUNS_FILE);
  if (!fs.existsSync(file)) return [];

  const byId = new Map();

  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    if (line.trim() === '') continue;

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;   // a torn write at the tail should not hide the other 200 runs
    }
    if (!record || typeof record.id !== 'string') continue;

    byId.set(record.id, { ...(byId.get(record.id) || {}), ...record });
  }

  return [...byId.values()]
    .map(run => (run.status === 'running' && run.id !== activeRunId)
      ? { ...run, status: 'interrupted' }
      : run)
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
    .slice(0, limit);
}

/**
 * Runs recorded before summary/story/usage were persisted on the end record
 * (or whose end record was lost) can usually be recovered from their event
 * file. Done lazily, once per run: the recovered fields are appended to
 * runs.jsonl, and a run with nothing to recover is stamped `backfilled` so the
 * event file is not re-read on every History request.
 */
export function backfillRuns(dir, runs) {
  return runs.map(run => {
    const finished = run.status !== 'running';
    const complete = run.summary !== undefined || run.story !== undefined || run.usage !== undefined;
    if (!finished || complete || run.backfilled) return run;

    const patch = { id: run.id, backfilled: true };
    const file = runEventsPath(dir, run.id);
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (!event) continue;
        if (event.t === 'summary') patch.summary = event.summary;
        if (event.t === 'story:done') patch.story = { date: event.date, pages: event.pages };
        if (event.t === 'claude:usage') patch.usage = addUsage(patch.usage || {}, event);
      }
    }

    appendRecord(dir, patch);
    return { ...run, ...patch };
  });
}
