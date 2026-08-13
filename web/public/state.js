// Folding the event stream into view state is the part of a no-framework UI
// that actually carries risk, so it lives here as a pure function and gets
// tested. Everything in app.js is DOM plumbing over this.
//
// Loaded both as an ES module in the browser and by Jest, so it imports nothing.

const MAX_LOG = 500;

export function initialState() {
  return {
    runId: null,
    kind: null,
    status: 'idle',        // idle | running | ok | failed | cancelled
    phase: null,
    accounts: 0,
    clubsTotal: 0,
    clubsDone: 0,
    postsFound: 0,
    eventsExtracted: 0,
    errors: [],
    current: null,
    sheet: null,
    summary: null,
    story: null,
    log: [],
    lastSeq: 0,
    durationMs: null,
    exitCode: null,
    stderr: null,
    startDate: null,
    endDate: null,
    backend: null
  };
}

export function reduce(state, event) {
  const next = { ...state, lastSeq: Math.max(state.lastSeq, event.seq || 0) };

  switch (event.t) {
    case 'run:start':
      return { ...initialState(), runId: event.runId, kind: event.kind, status: 'running', lastSeq: next.lastSeq };

    case 'run:config':
      return {
        ...next,
        accounts: event.accounts,
        clubsTotal: event.accounts,
        startDate: event.startDate,
        endDate: event.endDate,
        backend: event.backend
      };

    case 'phase':
      return { ...next, phase: event.name };

    case 'club:start':
      return { ...next, current: event.account, clubsTotal: event.total || next.clubsTotal };

    case 'club:done':
      return {
        ...next,
        clubsDone: event.index,
        clubsTotal: event.total || next.clubsTotal,
        postsFound: next.postsFound + (event.postsFound || 0),
        eventsExtracted: next.eventsExtracted + (event.eventsExtracted || 0),
        current: null
      };

    case 'club:error':
      // A failed club still counts as accounted for, or the progress bar stalls
      // at 84/85 on a run that actually finished.
      return {
        ...next,
        clubsDone: event.index,
        clubsTotal: event.total || next.clubsTotal,
        errors: [...next.errors, { account: event.account, message: event.message }],
        current: null
      };

    case 'sheet:write':
      return { ...next, sheet: { updated: event.updated, appended: event.appended, skipped: event.skipped } };

    case 'summary':
      return { ...next, summary: event.summary };

    case 'story:done':
      return { ...next, story: { date: event.date, pages: event.pages, files: event.files } };

    case 'run:end':
      return {
        ...next,
        status: event.status || (event.ok ? 'ok' : 'failed'),
        durationMs: event.durationMs ?? null,
        exitCode: event.exitCode ?? null,
        stderr: event.stderr || null,
        current: null
      };

    case 'log': {
      const log = [...next.log, { level: event.level, message: event.message }];
      return { ...next, log: log.length > MAX_LOG ? log.slice(log.length - MAX_LOG) : log };
    }

    default:
      return next;
  }
}

export function reduceAll(state, events) {
  return events.reduce(reduce, state);
}
