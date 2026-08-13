// runs.jsonl is append-only: a start record when a run begins, an end record
// when it finishes, folded by id at read time. Appending twice beats rewriting
// one record in place, because a crash between the read and the write would
// otherwise lose the run entirely.
import fs from 'fs';
import path from 'path';

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
