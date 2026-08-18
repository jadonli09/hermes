// Runs the pipeline as a child process rather than importing it.
//
// A scrape takes minutes and can be OOM-killed by a large carousel batch;
// in-process that would take the dashboard down with it. Out of process, the
// worst case is a failed run record.
//
// fd 3 carries structured progress (see utils/progress-events.js). stdout and
// stderr stay human-readable and are mirrored into the stream as log events.
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createLineDecoder, parseEvent } from './ndjson.js';
import { appendRecord, runEventsPath } from './history.js';
import { addUsage } from './usage.js';

const STDERR_TAIL_LINES = 20;
const SIGKILL_GRACE_MS = 10000;

export function createRunner({ projectDir, dataDir, hub, spawnFn = spawn, now = Date.now }) {
  let active = null;
  const waiters = new Map();   // runId -> () => Promise<endRecord>

  return {
    start({ kind, script, args = [] }) {
      if (active) {
        const error = new Error(`A ${active.kind} run is already in progress`);
        error.code = 'RUN_IN_PROGRESS';
        error.runId = active.runId;
        throw error;
      }

      const startedAt = now();
      const runId = `run-${startedAt}-${Math.random().toString(36).slice(2, 8)}`;

      const child = spawnFn(process.execPath, [path.join(projectDir, script), ...args], {
        cwd: projectDir,
        env: { ...process.env, HERMES_PROGRESS: 'json' },
        stdio: ['ignore', 'pipe', 'pipe', 'pipe']   // fd 3 is the progress channel
      });

      const eventsPath = runEventsPath(dataDir, runId);
      fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
      const eventsFile = fs.createWriteStream(eventsPath, { flags: 'a' });

      const stderrTail = [];
      const pending = [];
      let malformedLines = 0;
      let settled = null;

      // Folded onto the history record so History and the cost estimate can be
      // answered from runs.jsonl alone, without replaying every event file.
      let summary;
      let story;
      let usage;

      const publish = (event) => {
        const sequenced = hub.publish(runId, event);
        eventsFile.write(JSON.stringify(sequenced) + '\n');
        return sequenced;
      };

      active = { runId, kind, startedAt, child, cancelled: false, killTimer: null };

      appendRecord(dataDir, { id: runId, kind, status: 'running', startedAt });
      publish({ t: 'run:start', runId, kind, at: startedAt });

      // Progress channel
      const progressDecoder = createLineDecoder();
      const consume = (lines) => {
        for (const line of lines) {
          const event = parseEvent(line);
          if (!event) { malformedLines++; continue; }   // never fatal: one bad line must not end a run

          publish(event);
          if (event.t === 'summary') summary = event.summary;
          if (event.t === 'story:done') story = { date: event.date, pages: event.pages };
          if (event.t === 'claude:usage') usage = addUsage(usage || {}, event);
        }
      };
      child.stdio[3]?.on('data', chunk => consume(progressDecoder.push(chunk)));

      // Human output, mirrored so the log pane shows what the terminal would
      const mirror = (level, stream) => {
        const decoder = createLineDecoder();
        stream?.on('data', chunk => {
          for (const message of decoder.push(chunk)) {
            if (level === 'error') {
              stderrTail.push(message);
              if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
            }
            publish({ t: 'log', level, message, at: now() });
          }
        });
      };
      mirror('info', child.stdout);
      mirror('error', child.stderr);

      const finish = (exitCode, signal) => {
        if (settled) return;

        consume(progressDecoder.flush());

        const cancelled = active?.cancelled;
        const status = cancelled ? 'cancelled' : (exitCode === 0 ? 'ok' : 'failed');
        const endedAt = now();

        const record = {
          id: runId,
          status,
          exitCode,
          signal: signal || null,
          endedAt,
          durationMs: endedAt - startedAt,
          malformedLines,
          stderr: stderrTail.join('\n'),
          ...(summary !== undefined && { summary }),
          ...(story !== undefined && { story }),
          ...(usage !== undefined && { usage })
        };

        publish({ t: 'run:end', runId, ok: status === 'ok', ...record, at: endedAt });
        appendRecord(dataDir, record);

        if (active?.killTimer) clearTimeout(active.killTimer);
        active = null;                 // the lock releases here, on every path

        // Waiters are told the run is over only once its event file is flushed,
        // so a replay read straight after waitForExit sees every event.
        eventsFile.end(() => {
          settled = record;
          for (const resolve of pending.splice(0)) resolve(record);
        });
      };

      // 'close' rather than 'exit': exit can fire while stdout and fd 3 still
      // hold buffered data, which would drop the run's last events.
      child.on('close', finish);
      child.on('error', (error) => {
        publish({ t: 'log', level: 'error', message: `Failed to start: ${error.message}`, at: now() });
        finish(-1, null);
      });

      waiters.set(runId, () => settled ? Promise.resolve(settled) : new Promise(r => pending.push(r)));

      return { runId };
    },

    cancel(runId) {
      if (!active || active.runId !== runId) return false;

      active.cancelled = true;
      const { child } = active;
      child.kill('SIGTERM');

      // A pipeline blocked in a network read ignores SIGTERM. Escalate rather
      // than leaving the dashboard locked forever.
      active.killTimer = setTimeout(() => child.kill('SIGKILL'), SIGKILL_GRACE_MS);
      active.killTimer.unref?.();

      return true;
    },

    getActive() {
      return active ? { runId: active.runId, kind: active.kind, startedAt: active.startedAt } : null;
    },

    waitForExit(runId) {
      const waiter = waiters.get(runId);
      return waiter ? waiter() : Promise.reject(new Error(`Unknown run ${runId}`));
    }
  };
}
