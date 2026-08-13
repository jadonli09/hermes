# Hermes Web UI — Design

Date: 2026-08-12
Status: Approved

## Problem

Hermes runs from the terminal. Starting a run means remembering `npm start`, watching
`console.log` scroll past, and reading results in Google Sheets. Checking whether last
night's run did anything means opening `run-log.json`, which holds only the most recent
run. Generating the daily story is a second command with its own flags.

The daily ritual — run the scrape, watch it, generate the story, post it — should be a
browser tab.

## Goals

1. Start a scrape run and watch it progress live.
2. See the history of past runs and spot one that quietly did nothing.
3. Generate, preview, and download the daily story graphic.
4. Manage tracked accounts and the safe operational knobs.

## Non-goals

- **Reviewing or editing extracted events before they reach the Sheet.** The pipeline
  stays write-through. Adding a staging queue would mean real mutable state and a second
  source of truth for events; the Sheet remains authoritative.
- **Editing secrets from the browser.** `APIFY_TOKEN`, `ANTHROPIC_API_KEY`,
  `GOOGLE_SPREADSHEET_ID`, and `google-credentials.json` are never read or written by the
  web layer. This is what makes a future deploy safe by construction rather than by
  remembering to add auth.
- **Deploying.** Built for `localhost` now. The server/UI boundary is kept clean (HTTP +
  SSE over subprocesses, no Node-only assumptions in the frontend) so deploying later is
  additive work — auth and secret management — not a rewrite.
- **Replacing the CLI.** Every command keeps working exactly as it does today.

## Architecture

New `web/` directory. Nothing existing moves.

```
web/
  server.js      Node http server: JSON routes + static files
  runner.js      spawns and supervises subprocesses; owns the single-run lock
  events.js      SSE hub — fan-out, per-run buffer, replay on reconnect
  history.js     append/read runs.jsonl
  settings.js    validated reads/writes of accounts.json + allowlisted .env keys
  public/        index.html, app.js, style.css  (no build step)
```

One additive module in the pipeline: `utils/progress-events.js`. When `HERMES_PROGRESS=json`
is set it writes newline-delimited JSON to file descriptor 3; otherwise every call is a
no-op. Human `console.log` output is unchanged, so the terminal experience is byte-for-byte
identical and the web layer never parses prose.

### Why a subprocess rather than importing the pipeline

Two alternatives were considered and rejected:

- **Parse the CLI's stdout.** Zero pipeline changes, but progress would depend on log
  wording — rephrasing a `console.log` silently breaks the progress bar while the run is
  fine. Unacceptable for something relied on daily.
- **Refactor `main.js` into an importable `runPipeline()` and call it in-process.**
  Structured progress, but it puts a 10+ minute job inside the web server; a crash or
  memory spike in an Apify run takes the dashboard down with it.

The subprocess plus a structured event channel gets the isolation of the first and the
structure of the second, for one small additive change to the pipeline.

### Progress event call sites

| File | Events |
|---|---|
| `main.js` | `run:config`, `phase`, `sheet:write`, `summary` |
| `scraping-orchestrator.js` | `club:start`, `club:done`, `club:error` |
| `story.js` | `phase` for fetch / paginate / render, and `story:done` |

`club-processor.js` and `sheets-writer.js` need no changes: club stats are already
on `processClub`'s return value (`club-processor.js:197`) and sheet stats on
`writeResults`' (`sheets-manager.js:98`), so both are emitted by their callers.

`run:start` and `run:end` are synthesized by `web/runner.js` rather than emitted by
the pipeline, so the UI shows a live run the instant it spawns — even if the child
dies during config loading, before it could emit anything.

### Process model

`runner.js` spawns `node main.js` or `node story.js` with the parent environment plus
`HERMES_PROGRESS=json`, and a pipe on fd 3.

One run at a time, enforced by a lock. A second start request returns `409` naming the
active run rather than allowing two concurrent jobs to spend Apify credits and race to
write the same Sheet rows.

The lock releases in a `finally` bound to both the child's `exit` and `error` events, so a
crash cannot wedge the dashboard into a permanent "run in progress" state.

## Event contract

NDJSON on fd 3. Every event carries a monotonic `seq` assigned by the runner.

```js
// synthesized by web/runner.js
{ t:"run:start",   runId, kind:"scrape"|"story" }
{ t:"run:end",     runId, ok, status:"ok"|"failed"|"cancelled", exitCode, durationMs }

// emitted by the pipeline on fd 3
{ t:"run:config",  accounts, startDate, endDate, backend }
{ t:"phase",       name:"prefetch"|"process"|"write"|"fetch"|"paginate"|"render" }
{ t:"club:start",  index, total, account }
{ t:"club:done",   index, total, account, postsFound, eventsExtracted, durationMs }
{ t:"club:error",  index, total, account, message }
{ t:"sheet:write", updated, appended, skipped }
{ t:"summary",     summary }
{ t:"story:done",  date, pages, files }
{ t:"log",         level, message }
```

`seq` is what makes reconnection trustworthy: a browser that misses events knows it missed
them and re-syncs from the snapshot endpoint instead of rendering a stale progress bar.

## Data flow

`POST /api/runs` → runner takes the lock and spawns the child → each fd-3 line is parsed,
sequenced, appended to `runs/<id>.jsonl`, folded into in-memory state, and broadcast to SSE
subscribers → on child exit the runner appends a summary to `runs.jsonl`, releases the lock,
and emits `run:end`.

Events are buffered in memory *and* persisted per run. Closing the tab, refreshing, or
letting the laptop sleep does not lose the view of an in-flight run; the browser reconnects,
pulls a snapshot, and resumes. Any past run can be replayed from disk, which is what makes a
quiet failure diagnosable after the fact.

## HTTP API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/state` | Active run, last run summary, config summary |
| POST | `/api/runs` | Start a scrape run → `201 {runId}` or `409` |
| GET | `/api/runs/:id` | Snapshot of accumulated run state |
| GET | `/api/runs/:id/stream` | SSE event stream |
| POST | `/api/runs/:id/cancel` | SIGTERM the child |
| GET | `/api/history?limit=50` | Past runs from `runs.jsonl` |
| POST | `/api/story` | Generate story for a date → `201 {runId}` |
| GET | `/api/story/:date` | List rendered pages for a date |
| GET | `/api/story/:date/:page` | Serve a rendered PNG |
| GET | `/api/settings` | accounts.json + allowlisted env values |
| PUT | `/api/settings` | Validated, atomic write |

Server-Sent Events rather than WebSockets: progress is one-directional, SSE reconnects
automatically, and it needs no dependency.

## Screens

Single page, four tabs, plain HTML/CSS/JS. A React/Vite toolchain for four screens would add
more maintenance than it saves.

1. **Run** — Run button; live counters (clubs *N*/total, posts scraped, events extracted,
   errors); current club; collapsible raw log; Cancel. Finishes into a summary card linking
   to the Sheet.
2. **History** — past runs with duration, counts, failures, exit status. Clicking a row
   replays that run's stream from disk.
3. **Story** — date picker defaulting to today; Generate; preview at story aspect ratio;
   Download. "No events for this date" is a normal result, not an error.
4. **Settings** — accounts editor with live counts; the allowlisted knobs
   (`START_DAYS_AGO`, `MAX_CLUBS_TO_PROCESS`, `MAX_CAROUSEL_IMAGES`,
   `APIFY_MAX_CHARGE_USD`, `APIFY_RESULTS_LIMIT`). Secrets render as "set / not set",
   never values.

## Error handling

| Failure | Behavior |
|---|---|
| Partial NDJSON line across chunk boundary | Buffer until newline. Directly tested — likeliest source of silent corruption. |
| Malformed event line | Counted and logged, never fatal. A garbled line must not kill a live run view. |
| Child crash / OOM kill | Run marked failed with exit code and stderr tail; lock released. |
| Server restart mid-run | On boot, runs with no end record are marked `interrupted`, not left `running`. |
| Concurrent start request | `409` naming the active run. |
| Settings write | Validated against an allowlist; written atomically (temp file + rename). |
| SSE client disconnect | Subscriber removed; the run is unaffected. |
| Story with no events | Normal outcome, reported as such — matches `story.js:88`. |
| Port already in use | Clear message naming the port. |

## Testing

The runner is tested against **fixture child scripts** that emit scripted event sequences —
split lines, garbage lines, nonzero exits, hangs. The full run lifecycle is therefore covered
deterministically with no Apify, no Claude, and no Sheets calls. No test touches the network.

- **Unit** — event parser (chunk splitting, partial lines, malformed lines, `seq`
  assignment); history append/read; settings validation (allowlist, ranges, atomic write);
  lock acquire/release including the crash path.
- **Integration** — runner against fixture children, covering each failure mode in the table
  above.
- **API** — real HTTP server with a fake runner: 409-on-double-start, snapshot/stream
  consistency, cancel, static file serving.
- **Regression** — all 187 currently-passing tests stay green.

## Pre-existing issues fixed as part of this work

These are corrected because the web UI depends on them being right, not as unrelated cleanup:

1. **`dry-run-mode.js:140` reads legacy `clubs.json` (80 entries) instead of calling
   `loadAccounts()` (85 enabled).** The Run and Settings screens both display the account
   count; showing 80 while the run processes 85 would be a confidently-wrong dashboard. Its
   "Example Output Format" block also prints the pre-rename `meeting_*` schema.
2. **Five stale tests in `__tests__/sheets-writer.test.js`.** They assert against
   `meeting_date` / `meeting_time` / `meeting_type` / `recurrence`; the live schema
   (`schemas/claude-response.js:30`) uses `event_date` / `event_time` / `event_type` and
   dropped `recurrence` entirely. `compareEventData` is correct — the tests were never
   updated after the rename. A red suite trains you to ignore the suite.

## Open decisions deliberately deferred

- **Auth** — not needed on localhost; required before any deploy.
- **Scheduling** — the UI triggers runs manually. Cron/launchd scheduling is a separate
  concern and can be added without touching this design.
