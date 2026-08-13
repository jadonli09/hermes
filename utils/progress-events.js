// Structured progress for the web UI.
//
// The pipeline's console.log output is written for humans and gets reworded
// freely; anything that parses it breaks silently the moment someone edits a
// line. So when HERMES_PROGRESS=json is set we also write newline-delimited
// JSON to fd 3, which web/runner.js opens as a pipe when it spawns the run.
//
// fd 3 is not open when Hermes runs from a terminal. That is not worth crashing
// a real run over, so the first failed write turns the emitter off.
import fs from 'fs';

const PROGRESS_FD = 3;

let sink = null;
let disabled = false;

function defaultSink(line) {
  fs.writeSync(PROGRESS_FD, line);
}

/** Testing seam. Production code never calls this. */
export function setSink(fn) {
  sink = fn;
  disabled = false;
}

export function resetSink() {
  sink = null;
  disabled = false;
}

export function emit(t, payload = {}) {
  if (process.env.HERMES_PROGRESS !== 'json' || disabled) return;

  try {
    (sink || defaultSink)(JSON.stringify({ t, ...payload, at: Date.now() }) + '\n');
  } catch {
    disabled = true;
  }
}
