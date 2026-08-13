// Fan-out for run progress.
//
// The buffer is what makes a refresh, a sleeping laptop, or a dropped
// connection recoverable: a client reconnects with Last-Event-ID and gets
// exactly what it missed, instead of silently resuming against a progress bar
// that stopped moving.
export function createEventHub({ maxBuffer = 5000 } = {}) {
  const runs = new Map();   // runId -> { seq, buffer: [], subscribers: Set }

  function runState(runId) {
    if (!runs.has(runId)) {
      runs.set(runId, { seq: 0, buffer: [], subscribers: new Set() });
    }
    return runs.get(runId);
  }

  function frame(event) {
    return `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
  }

  function write(res, text) {
    try {
      res.write(text);
      return true;
    } catch {
      // A dead socket is normal - the browser closed the tab. Drop it and let
      // the run carry on.
      return false;
    }
  }

  return {
    publish(runId, event) {
      const state = runState(runId);
      const sequenced = { ...event, seq: ++state.seq };

      state.buffer.push(sequenced);
      if (state.buffer.length > maxBuffer) state.buffer.shift();

      const text = frame(sequenced);
      for (const res of [...state.subscribers]) {
        if (!write(res, text)) state.subscribers.delete(res);
      }

      return sequenced;
    },

    subscribe(runId, res, { lastEventId = null } = {}) {
      const state = runState(runId);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });

      const since = Number.parseInt(lastEventId, 10) || 0;
      for (const event of state.buffer) {
        if (event.seq > since) write(res, frame(event));
      }

      state.subscribers.add(res);
      res.on('close', () => state.subscribers.delete(res));

      return () => state.subscribers.delete(res);
    },

    getBuffer(runId, { since = 0 } = {}) {
      return runState(runId).buffer.filter(event => event.seq > since);
    },

    clear(runId) {
      runs.delete(runId);
    }
  };
}
