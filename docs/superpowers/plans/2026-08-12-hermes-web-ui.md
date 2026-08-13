# Hermes Web UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A localhost dashboard that starts Hermes runs, streams their progress live, keeps run history, generates and previews the daily story, and edits accounts plus safe settings.

**Architecture:** A small Node `http` server spawns `main.js` / `story.js` as subprocesses with a pipe on file descriptor 3. When `HERMES_PROGRESS=json` is set, the pipeline writes newline-delimited JSON progress events to that fd; the server sequences them, persists them per run, and fans them out over Server-Sent Events. Human `console.log` output is untouched, so the CLI behaves exactly as before and the web layer never parses prose.

**Tech Stack:** Node 22 ESM, no new runtime dependencies. Jest (`node --experimental-vm-modules`) for tests. Frontend is plain HTML/CSS/JS with no build step.

## Global Constraints

- **No new runtime dependencies.** Node built-ins only (`http`, `child_process`, `fs`, `path`, `node:string_decoder`). Jest stays the only devDependency.
- **ESM throughout.** `package.json` has `"type": "module"`. Use `import`, never `require`.
- **Tests run with** `npm test` (which is `node --experimental-vm-modules node_modules/jest/bin/jest.js`). Import `jest` from `@jest/globals` when you need it, matching `__tests__/apify-scraper.test.js:1`.
- **No test touches the network, Apify, Claude, or Google Sheets.** The runner is exercised against fixture child scripts.
- **Secrets are never read or written by the web layer.** `APIFY_TOKEN`, `ANTHROPIC_API_KEY`, `GOOGLE_SPREADSHEET_ID`, `GOOGLE_DRIVE_FOLDER_ID`, `INSTAGRAM_*` and `google-credentials.json` are off-limits to `web/settings.js` except to report presence as `"set"` / `"missing"`.
- **The CLI keeps working unchanged.** Every existing `npm` script behaves identically when `HERMES_PROGRESS` is unset.
- **Server binds `127.0.0.1` only.** Never `0.0.0.0` — there is no auth.
- **Comment style:** match the codebase — explain *why*, not *what*. See `scrapers/apify-scraper.js:1-8` for the house voice.

---

## Event contract (authoritative)

This refines the spec in two ways, both discovered while reading the code. Task 1 updates the spec document to match.

1. **The runner synthesizes `run:start`** the moment it spawns, so the UI shows a live run instantly even if the child dies during config loading. The pipeline emits **`run:config`** once account selection is known.
2. **Instrumentation touches three files, not five.** `club:done` stats already exist on `processClub`'s return value (`club-processor.js:197`), and `sheet:write` stats are returned by `sheetsManager.writeResults` (`sheets-manager.js:98`), so both are emitted from their callers. `club-processor.js` and `sheets-writer.js` need no changes.

```js
// emitted by web/runner.js
{ t:"run:start",   runId, kind:"scrape"|"story", at }
{ t:"run:end",     runId, ok, status:"ok"|"failed"|"cancelled", exitCode, durationMs, at }

// emitted by the pipeline on fd 3
{ t:"run:config",  accounts, startDate, endDate, backend, at }
{ t:"phase",       name:"prefetch"|"process"|"write"|"fetch"|"paginate"|"render", at }
{ t:"club:start",  index, total, account, at }
{ t:"club:done",   index, total, account, postsFound, eventsExtracted, durationMs, at }
{ t:"club:error",  index, total, account, message, at }
{ t:"sheet:write", updated, appended, skipped, at }
{ t:"summary",     summary, at }              // metrics.getSummary()
{ t:"story:done",  date, pages, files, at }
{ t:"log",         level:"info"|"warn"|"error", message, at }
```

Every event gains a monotonic `seq` assigned by `web/events.js` when published.

---

## File structure

| File | Responsibility |
|---|---|
| `utils/progress-events.js` | Emit NDJSON on fd 3 when enabled; no-op otherwise |
| `web/ndjson.js` | Chunk → line decoding and event parsing (pure) |
| `web/history.js` | Append/read `runs.jsonl`; derive `interrupted` status |
| `web/events.js` | SSE hub: seq assignment, per-run buffer, replay, fan-out |
| `web/runner.js` | Spawn/supervise subprocesses; single-run lock; cancel |
| `web/settings.js` | Allowlisted, validated, atomic reads/writes of `accounts.json` and `.env` |
| `web/server.js` | HTTP routes + static file serving |
| `web/public/state.js` | Pure reducer: `(state, event) → state` (shared by UI, unit-tested) |
| `web/public/index.html` | Four-tab shell |
| `web/public/app.js` | DOM rendering, SSE subscription, fetch calls |
| `web/public/style.css` | Styling |

---

### Task 1: Green baseline — fix the two pre-existing defects

The web UI displays the account count and depends on a trustworthy test suite. Both are currently wrong. Fix them before building on top.

**Files:**
- Modify: `dry-run-mode.js:137-170`
- Modify: `__tests__/sheets-writer.test.js:129-290`
- Modify: `docs/superpowers/specs/2026-08-12-hermes-web-ui-design.md`

**Interfaces:**
- Consumes: `loadAccounts(basePath, category)` from `config-manager.js:203`, returning `{ accounts: string[], categories: Object, allAccounts: string[] }`
- Produces: nothing new; a green `npm test` and a dry run that reports 85 accounts

- [ ] **Step 1: Confirm the failures are real**

Run: `npm test 2>&1 | tail -5`
Expected: `Tests: 5 failed, 187 passed, 192 total`

Run: `DRY_RUN=true npm start 2>&1 | grep "Clubs Found"`
Expected: `Clubs Found:             80` (wrong — `accounts.json` has 85 enabled)

- [ ] **Step 2: Fix the five stale tests**

In `__tests__/sheets-writer.test.js`, the `baseEvent` fixture and its assertions use a schema that no longer exists. `schemas/claude-response.js:30` defines `event_date` / `event_time` / `event_type`, and `recurrence` was dropped entirely. Replace the fixture:

```js
    const baseEvent = {
      club_name: 'Chess Club',
      event_date: '2024-01-15',
      event_time: '3:30 PM',
      event_type: 'Club Meeting',
      location: 'Room B101',
      description: 'Weekly meeting',
      confidence: '0.9'
    };
```

Then in the same file: rename every `meeting_date` → `event_date`, `meeting_time` → `event_time`, `meeting_type` → `event_type` in the `field changes`, `date format normalization`, and `edge cases` blocks. Delete the `recurrence` key from every fixture, and delete the test named `should return true when recurrence changes` — `compareEventData` deliberately does not compare a field that is not in the schema.

- [ ] **Step 3: Run the tests**

Run: `npm test 2>&1 | tail -5`
Expected: `Tests: 191 passed, 191 total` (192 minus the deleted `recurrence` test)

- [ ] **Step 4: Fix dry-run account loading**

`dry-run-mode.js:140` reads legacy `clubs.json` directly. Replace the whole "4. Load and validate clubs" block with a call to the same loader `main.js:107` uses. Add `loadAccounts` to the existing import from `./config-manager.js`, then:

```js
  // 4. Load and validate accounts
  console.log('\n--- 4. Accounts Validation ---');
  try {
    // main.js loads through loadAccounts, so the dry run must too. Reading
    // clubs.json directly reported 80 accounts while the real run processed 85,
    // which makes the dry run worse than useless as a pre-flight check.
    const { accounts, categories } = loadAccounts(basePath, config.category);

    results.clubsFound = accounts.length;
    console.log(`✓ Found ${results.clubsFound} enabled account(s) in accounts.json`);

    const summary = Object.entries(categories)
      .map(([name, cat]) => `${name}: ${cat.accounts?.length || 0}${cat.enabled === false ? ' (disabled)' : ''}`);
    console.log(`  Categories: ${summary.join(', ')}`);

    if (config.testClub) {
      if (accounts.includes(config.testClub)) {
        results.clubsToProcess = [config.testClub];
        console.log(`\n  TEST_CLUB set: would process only @${config.testClub}`);
      } else {
        console.error(`\n  ✗ TEST_CLUB "${config.testClub}" not found in accounts.json`);
      }
    } else {
      results.clubsToProcess = accounts.slice(0, Math.min(config.maxClubsToProcess, accounts.length));
      console.log(`\n  Would process ${results.clubsToProcess.length} account(s):`);
      results.clubsToProcess.forEach((club, i) => {
        console.log(`    ${i + 1}. @${club}`);
      });
    }
  } catch (error) {
    console.error(`✗ Account loading failed: ${error.message}`);
  }
```

- [ ] **Step 5: Fix the stale example-output block**

Further down `dry-run-mode.js`, the "Example Output Format" prints the pre-rename schema. Replace that object literal with the current one:

```js
  console.log(JSON.stringify({
    club_name: 'example_club',
    event_date: '2026-01-15',
    event_time: '3:30 PM',
    event_type: 'Club Meeting',
    location: 'Room B101',
    description: 'Weekly club meeting to discuss upcoming events',
    confidence: 0.85,
    post_url: 'https://www.instagram.com/p/ABC123/',
    posted_date: '2026-01-10',
    account_name: 'example_club'
  }, null, 2));
```

- [ ] **Step 6: Verify the dry run reports the true count**

Run: `DRY_RUN=true npm start 2>&1 | grep -E "Clubs Found|Categories"`
Expected: `Clubs Found:             85` and a category line showing `clubs: 79, disbanded_2026_27: 17 (disabled), asb: 6, sports: 0`

- [ ] **Step 7: Update the spec to match the refined event contract**

In `docs/superpowers/specs/2026-08-12-hermes-web-ui-design.md`, replace the "Progress event call sites" table with:

```markdown
| File | Events |
|---|---|
| `main.js` | `run:config`, `phase`, `sheet:write`, `summary` |
| `scraping-orchestrator.js` | `club:start`, `club:done`, `club:error` |
| `story.js` | `phase`, `story:done` |

`club-processor.js` and `sheets-writer.js` need no changes: club stats are already
on `processClub`'s return value and sheet stats on `writeResults`', so both are
emitted by their callers.
```

And in the "Event contract" section, replace the `run:start` line with the runner-synthesized form plus `run:config`, matching the plan's authoritative contract.

- [ ] **Step 8: Commit**

```bash
git add dry-run-mode.js __tests__/sheets-writer.test.js docs/superpowers/specs/2026-08-12-hermes-web-ui-design.md
git commit -m "Fix dry-run account loading and stale sheets-writer tests

The dry run read legacy clubs.json (80 entries) while the real run loads
accounts.json (85 enabled), so it reported a count the run never used.

The sheets-writer tests asserted against meeting_date/meeting_time/
meeting_type/recurrence, none of which survive in schemas/claude-response.js.
compareEventData was right; the tests were never updated after the rename."
```

---

### Task 2: Progress event emitter

**Files:**
- Create: `utils/progress-events.js`
- Test: `__tests__/progress-events.test.js`

**Interfaces:**
- Produces:
  - `emit(t: string, payload?: object): void` — writes `{t, ...payload, at}` + `\n` to fd 3 when `process.env.HERMES_PROGRESS === 'json'`
  - `setSink(fn: (line: string) => void): void` — testing seam
  - `resetSink(): void`

- [ ] **Step 1: Write the failing test**

```js
// __tests__/progress-events.test.js
import { emit, setSink, resetSink } from '../utils/progress-events.js';

describe('progress events', () => {
  let lines;

  beforeEach(() => {
    lines = [];
    setSink(line => lines.push(line));
  });

  afterEach(() => {
    resetSink();
    delete process.env.HERMES_PROGRESS;
  });

  it('writes nothing when HERMES_PROGRESS is unset', () => {
    emit('phase', { name: 'process' });
    expect(lines).toEqual([]);
  });

  it('writes one newline-terminated JSON object when enabled', () => {
    process.env.HERMES_PROGRESS = 'json';
    emit('phase', { name: 'process' });

    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith('\n')).toBe(true);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.t).toBe('phase');
    expect(parsed.name).toBe('process');
    expect(typeof parsed.at).toBe('number');
  });

  it('falls silent after a write failure instead of throwing', () => {
    process.env.HERMES_PROGRESS = 'json';
    setSink(() => { throw new Error('EBADF'); });

    expect(() => emit('phase', { name: 'process' })).not.toThrow();

    // A run started by hand with HERMES_PROGRESS=json has no fd 3. One failed
    // write must not turn into thousands.
    let calls = 0;
    setSink(() => { calls++; });
    resetSink();
    setSink(line => lines.push(line));
    emit('phase', { name: 'write' });
    expect(lines).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- progress-events 2>&1 | tail -10`
Expected: FAIL — `Cannot find module '../utils/progress-events.js'`

- [ ] **Step 3: Implement**

```js
// utils/progress-events.js
//
// Structured progress for the web UI. The pipeline's console.log output is for
// humans and changes freely; anything that parses it breaks the moment someone
// rewords a line. So when HERMES_PROGRESS=json is set we also write newline-
// delimited JSON to fd 3, which web/runner.js opens as a pipe.
//
// fd 3 is not open when Hermes runs from a terminal. That is not an error worth
// crashing a real run over - the first failed write turns the emitter off.
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- progress-events 2>&1 | tail -10`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add utils/progress-events.js __tests__/progress-events.test.js
git commit -m "Add structured progress event emitter on fd 3"
```

---

### Task 3: NDJSON decoding

**Files:**
- Create: `web/ndjson.js`
- Test: `__tests__/web-ndjson.test.js`

**Interfaces:**
- Produces:
  - `createLineDecoder(): { push(chunk: Buffer): string[], flush(): string[] }`
  - `parseEvent(line: string): object | null` — returns `null` for anything without a string `t`

- [ ] **Step 1: Write the failing test**

```js
// __tests__/web-ndjson.test.js
import { createLineDecoder, parseEvent } from '../web/ndjson.js';

describe('createLineDecoder', () => {
  it('returns complete lines and holds the partial one back', () => {
    const d = createLineDecoder();
    expect(d.push(Buffer.from('{"a":1}\n{"b":2}\n{"c":'))).toEqual(['{"a":1}', '{"b":2}']);
    expect(d.push(Buffer.from('3}\n'))).toEqual(['{"c":3}']);
  });

  it('reassembles a line split across many chunks', () => {
    const d = createLineDecoder();
    for (const piece of ['{"t":', '"phase",', '"name":', '"process"}']) {
      expect(d.push(Buffer.from(piece))).toEqual([]);
    }
    expect(d.push(Buffer.from('\n'))).toEqual(['{"t":"phase","name":"process"}']);
  });

  it('reassembles a multi-byte character split across chunks', () => {
    // Club captions carry emoji. Decoding each chunk independently would turn a
    // split code point into replacement characters and corrupt the JSON.
    const full = Buffer.from('{"t":"log","message":"✓ done"}\n', 'utf8');
    const d = createLineDecoder();
    const cut = full.indexOf(Buffer.from('✓', 'utf8')) + 1;

    expect(d.push(full.subarray(0, cut))).toEqual([]);
    expect(d.push(full.subarray(cut))).toEqual(['{"t":"log","message":"✓ done"}']);
  });

  it('skips blank lines', () => {
    const d = createLineDecoder();
    expect(d.push(Buffer.from('\n\n{"a":1}\n'))).toEqual(['{"a":1}']);
  });

  it('flush returns a trailing line that never got its newline', () => {
    const d = createLineDecoder();
    d.push(Buffer.from('{"a":1}'));
    expect(d.flush()).toEqual(['{"a":1}']);
    expect(d.flush()).toEqual([]);
  });
});

describe('parseEvent', () => {
  it('parses a well-formed event', () => {
    expect(parseEvent('{"t":"phase","name":"write"}')).toEqual({ t: 'phase', name: 'write' });
  });

  it('returns null for malformed JSON rather than throwing', () => {
    expect(parseEvent('{"t":')).toBeNull();
    expect(parseEvent('not json at all')).toBeNull();
  });

  it('returns null for JSON without a string type tag', () => {
    expect(parseEvent('{"name":"write"}')).toBeNull();
    expect(parseEvent('{"t":42}')).toBeNull();
    expect(parseEvent('null')).toBeNull();
    expect(parseEvent('[1,2,3]')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- web-ndjson 2>&1 | tail -10`
Expected: FAIL — `Cannot find module '../web/ndjson.js'`

- [ ] **Step 3: Implement**

```js
// web/ndjson.js
//
// Turning a byte stream into events has two classic failure modes, and both
// produce a dashboard that is confidently wrong rather than obviously broken:
// a line split across two reads, and a multi-byte character split across two
// reads. StringDecoder handles the second; the buffer here handles the first.
import { StringDecoder } from 'node:string_decoder';

export function createLineDecoder() {
  const decoder = new StringDecoder('utf8');
  let buffer = '';

  return {
    push(chunk) {
      buffer += decoder.write(chunk);

      const parts = buffer.split('\n');
      buffer = parts.pop();   // '' when the chunk ended on a newline

      return parts.filter(line => line.trim() !== '');
    },

    flush() {
      const rest = (buffer + decoder.end()).trim();
      buffer = '';
      return rest ? [rest] : [];
    }
  };
}

/**
 * @returns {Object|null} - null for anything that is not a tagged event object.
 *   Callers count nulls and carry on: one garbled line must not end a live run.
 */
export function parseEvent(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (typeof parsed.t !== 'string') return null;

  return parsed;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- web-ndjson 2>&1 | tail -10`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add web/ndjson.js __tests__/web-ndjson.test.js
git commit -m "Add NDJSON line decoding for the web runner"
```

---

### Task 4: Run history

**Files:**
- Create: `web/history.js`
- Test: `__tests__/web-history.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces:
  - `appendRecord(dir: string, record: object): void` — appends one JSON line to `<dir>/runs.jsonl`
  - `readRuns(dir: string, { limit = 50, activeRunId = null } = {}): object[]` — newest first, folded by `id`; a `running` record that is not `activeRunId` is reported as `status: 'interrupted'`
  - `runEventsPath(dir: string, runId: string): string`

- [ ] **Step 1: Write the failing test**

```js
// __tests__/web-history.test.js
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
    // The server was killed mid-run. Nothing ever wrote an end record, so the
    // status is derived at read time rather than repaired by a write - a repair
    // write would itself be lost to the next crash.
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
});

describe('runEventsPath', () => {
  it('places per-run event logs under runs/', () => {
    expect(runEventsPath(dir, 'r1')).toBe(path.join(dir, 'runs', 'r1.jsonl'));
  });

  it('refuses a run id that would escape the directory', () => {
    expect(() => runEventsPath(dir, '../../etc/passwd')).toThrow(/invalid run id/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- web-history 2>&1 | tail -10`
Expected: FAIL — `Cannot find module '../web/history.js'`

- [ ] **Step 3: Implement**

```js
// web/history.js
//
// runs.jsonl is append-only: a start record when a run begins, an end record
// when it finishes, folded by id at read time. Appending twice beats rewriting
// one record in place, because a crash between read and write would otherwise
// lose the run entirely.
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- web-history 2>&1 | tail -10`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add web/history.js __tests__/web-history.test.js
git commit -m "Add append-only run history with derived interrupted status"
```

---

### Task 5: SSE event hub

**Files:**
- Create: `web/events.js`
- Test: `__tests__/web-events.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: `createEventHub({ maxBuffer = 5000 } = {})` with
  - `publish(runId: string, event: object): object` — returns the event with `seq` assigned
  - `subscribe(runId: string, res, { lastEventId = null } = {}): () => void` — returns an unsubscribe function
  - `getBuffer(runId: string, { since = 0 } = {}): object[]`
  - `clear(runId: string): void`

- [ ] **Step 1: Write the failing test**

```js
// __tests__/web-events.test.js
import { createEventHub } from '../web/events.js';

const fakeRes = () => ({
  headers: null,
  chunks: [],
  writableEnded: false,
  writeHead(code, headers) { this.headers = { code, ...headers }; },
  write(chunk) { this.chunks.push(chunk); return true; },
  end() { this.writableEnded = true; },
  on() {}
});

describe('createEventHub', () => {
  it('assigns monotonic seq numbers per run', () => {
    const hub = createEventHub();
    expect(hub.publish('r1', { t: 'phase' }).seq).toBe(1);
    expect(hub.publish('r1', { t: 'phase' }).seq).toBe(2);
    expect(hub.publish('r2', { t: 'phase' }).seq).toBe(1);
  });

  it('delivers events to a subscriber as SSE frames', () => {
    const hub = createEventHub();
    const res = fakeRes();
    hub.subscribe('r1', res);
    hub.publish('r1', { t: 'phase', name: 'write' });

    expect(res.headers.code).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/event-stream');

    const frame = res.chunks.join('');
    expect(frame).toContain('id: 1\n');
    expect(frame).toContain('"name":"write"');
    expect(frame.endsWith('\n\n')).toBe(true);
  });

  it('replays buffered events to a subscriber that joins mid-run', () => {
    const hub = createEventHub();
    hub.publish('r1', { t: 'phase', name: 'prefetch' });
    hub.publish('r1', { t: 'phase', name: 'process' });

    const res = fakeRes();
    hub.subscribe('r1', res);

    const frames = res.chunks.join('');
    expect(frames).toContain('prefetch');
    expect(frames).toContain('process');
  });

  it('replays only what a reconnecting client missed', () => {
    const hub = createEventHub();
    hub.publish('r1', { t: 'phase', name: 'prefetch' });
    hub.publish('r1', { t: 'phase', name: 'process' });

    const res = fakeRes();
    hub.subscribe('r1', res, { lastEventId: '1' });

    const frames = res.chunks.join('');
    expect(frames).not.toContain('prefetch');
    expect(frames).toContain('process');
  });

  it('stops writing to a subscriber after it unsubscribes', () => {
    const hub = createEventHub();
    const res = fakeRes();
    const unsubscribe = hub.subscribe('r1', res);
    unsubscribe();

    hub.publish('r1', { t: 'phase', name: 'write' });
    expect(res.chunks.join('')).not.toContain('write');
  });

  it('survives a subscriber whose socket throws on write', () => {
    const hub = createEventHub();
    const bad = { ...fakeRes(), write() { throw new Error('EPIPE'); } };
    const good = fakeRes();
    hub.subscribe('r1', bad);
    hub.subscribe('r1', good);

    expect(() => hub.publish('r1', { t: 'phase', name: 'write' })).not.toThrow();
    expect(good.chunks.join('')).toContain('write');
  });

  it('caps the buffer so a long run cannot exhaust memory', () => {
    const hub = createEventHub({ maxBuffer: 3 });
    for (let i = 0; i < 10; i++) hub.publish('r1', { t: 'log', message: `m${i}` });

    const buffered = hub.getBuffer('r1');
    expect(buffered).toHaveLength(3);
    expect(buffered.at(-1).message).toBe('m9');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- web-events 2>&1 | tail -10`
Expected: FAIL — `Cannot find module '../web/events.js'`

- [ ] **Step 3: Implement**

```js
// web/events.js
//
// Fan-out for run progress. The buffer is what makes a refresh, a sleeping
// laptop, or a dropped connection recoverable: a client reconnects with
// Last-Event-ID and gets exactly what it missed, instead of silently resuming
// against a progress bar that stopped moving.
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
    } catch {
      // A dead socket is normal - the browser closed the tab. Drop it and let
      // the run carry on.
      return false;
    }
    return true;
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- web-events 2>&1 | tail -10`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add web/events.js __tests__/web-events.test.js
git commit -m "Add SSE hub with per-run buffering and gap-free replay"
```

---

### Task 6: Subprocess runner

**Files:**
- Create: `web/runner.js`
- Create: `__tests__/fixtures/child-ok.js`
- Create: `__tests__/fixtures/child-split-lines.js`
- Create: `__tests__/fixtures/child-garbage.js`
- Create: `__tests__/fixtures/child-crash.js`
- Create: `__tests__/fixtures/child-hang.js`
- Test: `__tests__/web-runner.test.js`

**Interfaces:**
- Consumes: `createLineDecoder`, `parseEvent` (Task 3); `appendRecord`, `runEventsPath` (Task 4); `createEventHub` (Task 5)
- Produces: `createRunner({ projectDir, dataDir, hub, spawnFn = spawn, now = Date.now })` with
  - `start({ kind: 'scrape'|'story', script: string, args?: string[] }): { runId: string }` — throws `Error` with `.code === 'RUN_IN_PROGRESS'` when busy
  - `cancel(runId: string): boolean`
  - `getActive(): { runId, kind, startedAt } | null`
  - `waitForExit(runId: string): Promise<object>` — resolves with the end record (test convenience)

- [ ] **Step 1: Write the fixture children**

```js
// __tests__/fixtures/child-ok.js
// Emits a well-formed run on fd 3, then exits cleanly.
import fs from 'fs';

fs.writeSync(3, JSON.stringify({ t: 'run:config', accounts: 2, startDate: '2026-08-05' }) + '\n');
fs.writeSync(3, JSON.stringify({ t: 'club:start', index: 1, total: 2, account: 'msjbio' }) + '\n');
fs.writeSync(3, JSON.stringify({ t: 'club:done', index: 1, total: 2, account: 'msjbio', postsFound: 3, eventsExtracted: 2 }) + '\n');
console.log('human readable output');
fs.writeSync(3, JSON.stringify({ t: 'summary', summary: { clubsProcessed: 2 } }) + '\n');
process.exit(0);
```

```js
// __tests__/fixtures/child-split-lines.js
// Writes one event in three separate writes with the newline last, which is what
// a real pipe delivers when the event straddles a buffer boundary.
import fs from 'fs';

fs.writeSync(3, '{"t":"club:start",');
fs.writeSync(3, '"index":1,"total":1,');
fs.writeSync(3, '"account":"msjbio"}\n');
process.exit(0);
```

```js
// __tests__/fixtures/child-garbage.js
// A malformed line between two good ones must not end the run.
import fs from 'fs';

fs.writeSync(3, JSON.stringify({ t: 'phase', name: 'prefetch' }) + '\n');
fs.writeSync(3, 'not json at all\n');
fs.writeSync(3, '{"missing":"type tag"}\n');
fs.writeSync(3, JSON.stringify({ t: 'phase', name: 'process' }) + '\n');
process.exit(0);
```

```js
// __tests__/fixtures/child-crash.js
// Mirrors main.js:191 - prints to stderr and exits nonzero.
import fs from 'fs';

fs.writeSync(3, JSON.stringify({ t: 'phase', name: 'prefetch' }) + '\n');
console.error('Apify API 402: out of credit');
process.exit(1);
```

```js
// __tests__/fixtures/child-hang.js
// Never exits on its own. Used to test cancel().
setInterval(() => {}, 1000);
```

- [ ] **Step 2: Write the failing test**

```js
// __tests__/web-runner.test.js
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createEventHub } from '../web/events.js';
import { createRunner } from '../web/runner.js';
import { readRuns } from '../web/history.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

let dataDir;
let hub;
let runner;

const collect = (runId) => hub.getBuffer(runId).map(e => e.t);

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-runner-'));
  hub = createEventHub();
  runner = createRunner({ projectDir: fixtures, dataDir, hub });
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('createRunner', () => {
  it('streams events from a healthy child and records success', async () => {
    const { runId } = runner.start({ kind: 'scrape', script: 'child-ok.js' });
    const end = await runner.waitForExit(runId);

    expect(collect(runId)).toEqual([
      'run:start', 'run:config', 'club:start', 'club:done', 'log', 'summary', 'run:end'
    ]);
    expect(end).toMatchObject({ status: 'ok', exitCode: 0 });

    const [record] = readRuns(dataDir);
    expect(record).toMatchObject({ id: runId, kind: 'scrape', status: 'ok' });
  });

  it('reassembles an event split across writes', async () => {
    const { runId } = runner.start({ kind: 'scrape', script: 'child-split-lines.js' });
    await runner.waitForExit(runId);

    const clubStart = hub.getBuffer(runId).find(e => e.t === 'club:start');
    expect(clubStart).toMatchObject({ index: 1, total: 1, account: 'msjbio' });
  });

  it('skips malformed lines and keeps the run going', async () => {
    const { runId } = runner.start({ kind: 'scrape', script: 'child-garbage.js' });
    const end = await runner.waitForExit(runId);

    const phases = hub.getBuffer(runId).filter(e => e.t === 'phase').map(e => e.name);
    expect(phases).toEqual(['prefetch', 'process']);
    expect(end.status).toBe('ok');
    expect(end.malformedLines).toBe(2);
  });

  it('records a nonzero exit as failed and keeps the stderr tail', async () => {
    const { runId } = runner.start({ kind: 'scrape', script: 'child-crash.js' });
    const end = await runner.waitForExit(runId);

    expect(end).toMatchObject({ status: 'failed', exitCode: 1 });
    expect(end.stderr).toContain('out of credit');

    expect(readRuns(dataDir)[0].status).toBe('failed');
  });

  it('refuses a second run while one is active', async () => {
    const { runId } = runner.start({ kind: 'scrape', script: 'child-hang.js' });

    // Two concurrent runs would both spend Apify credits and race to write the
    // same sheet rows, so this must be refused rather than queued.
    expect(() => runner.start({ kind: 'scrape', script: 'child-ok.js' }))
      .toThrow(expect.objectContaining({ code: 'RUN_IN_PROGRESS' }));

    runner.cancel(runId);
    await runner.waitForExit(runId);
  });

  it('releases the lock once a run finishes', async () => {
    const first = runner.start({ kind: 'scrape', script: 'child-ok.js' });
    await runner.waitForExit(first.runId);

    expect(runner.getActive()).toBeNull();
    const second = runner.start({ kind: 'scrape', script: 'child-ok.js' });
    await runner.waitForExit(second.runId);
  });

  it('releases the lock even when the child crashes', async () => {
    const { runId } = runner.start({ kind: 'scrape', script: 'child-crash.js' });
    await runner.waitForExit(runId);

    expect(runner.getActive()).toBeNull();
  });

  it('cancels a hung run', async () => {
    const { runId } = runner.start({ kind: 'scrape', script: 'child-hang.js' });

    expect(runner.cancel(runId)).toBe(true);
    const end = await runner.waitForExit(runId);

    expect(end.status).toBe('cancelled');
    expect(runner.getActive()).toBeNull();
  });

  it('persists events so a finished run can be replayed', async () => {
    const { runId } = runner.start({ kind: 'scrape', script: 'child-ok.js' });
    await runner.waitForExit(runId);

    const lines = fs.readFileSync(path.join(dataDir, 'runs', `${runId}.jsonl`), 'utf-8')
      .trim().split('\n').map(JSON.parse);

    expect(lines.map(e => e.t)).toContain('club:done');
    expect(lines.every(e => typeof e.seq === 'number')).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- web-runner 2>&1 | tail -10`
Expected: FAIL — `Cannot find module '../web/runner.js'`

- [ ] **Step 4: Implement**

```js
// web/runner.js
//
// Runs the pipeline as a child process rather than importing it. A scrape takes
// minutes and can be OOM-killed by a large carousel batch; in-process that would
// take the dashboard down with it. Out of process, the worst case is a failed
// run record.
//
// fd 3 carries structured progress (see utils/progress-events.js). stdout and
// stderr stay human-readable and are mirrored into the stream as log events.
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createLineDecoder, parseEvent } from './ndjson.js';
import { appendRecord, runEventsPath } from './history.js';

const STDERR_TAIL_LINES = 20;
const SIGKILL_GRACE_MS = 10000;

export function createRunner({ projectDir, dataDir, hub, spawnFn = spawn, now = Date.now }) {
  let active = null;

  function makeRunId(startedAt) {
    return `run-${startedAt}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function start({ kind, script, args = [] }) {
    if (active) {
      const error = new Error(`A ${active.kind} run is already in progress`);
      error.code = 'RUN_IN_PROGRESS';
      error.runId = active.runId;
      throw error;
    }

    const startedAt = now();
    const runId = makeRunId(startedAt);

    const child = spawnFn(process.execPath, [path.join(projectDir, script), ...args], {
      cwd: projectDir,
      env: { ...process.env, HERMES_PROGRESS: 'json' },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe']   // fd 3 is the progress channel
    });

    const eventsPath = runEventsPath(dataDir, runId);
    fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
    const eventsFile = fs.createWriteStream(eventsPath, { flags: 'a' });

    const stderrTail = [];
    let malformedLines = 0;
    let settled = null;
    const waiters = [];

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
        if (event) publish(event);
        else malformedLines++;   // never fatal: one bad line must not end a run
      }
    };
    child.stdio[3].on('data', chunk => consume(progressDecoder.push(chunk)));

    // Human output, mirrored so the log pane shows what the terminal would
    const mirror = (level, stream) => {
      const decoder = createLineDecoder();
      stream.on('data', chunk => {
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

      const wasCancelled = active?.cancelled;
      const status = wasCancelled ? 'cancelled' : (exitCode === 0 ? 'ok' : 'failed');
      const endedAt = now();

      const record = {
        id: runId,
        status,
        exitCode,
        signal: signal || null,
        endedAt,
        durationMs: endedAt - startedAt,
        malformedLines,
        stderr: stderrTail.join('\n')
      };

      publish({ t: 'run:end', runId, ok: status === 'ok', ...record, at: endedAt });
      appendRecord(dataDir, record);
      eventsFile.end();

      if (active?.killTimer) clearTimeout(active.killTimer);
      active = null;                        // the lock releases here, on every path
      settled = record;
      for (const resolve of waiters.splice(0)) resolve(record);
    };

    child.on('exit', finish);
    child.on('error', (error) => {
      publish({ t: 'log', level: 'error', message: `Failed to start: ${error.message}`, at: now() });
      finish(-1, null);
    });

    return {
      runId,
      waitForExit: () => settled ? Promise.resolve(settled) : new Promise(r => waiters.push(r))
    };
  }

  return {
    start(options) {
      const { runId, waitForExit } = start(options);
      waiters.set(runId, waitForExit);
      return { runId };
    },

    cancel(runId) {
      if (!active || active.runId !== runId) return false;

      active.cancelled = true;
      active.child.kill('SIGTERM');

      // A pipeline stuck in a network read ignores SIGTERM. Escalate rather than
      // leaving the dashboard locked forever.
      const child = active.child;
      active.killTimer = setTimeout(() => child.kill('SIGKILL'), SIGKILL_GRACE_MS);
      active.killTimer.unref?.();

      return true;
    },

    getActive() {
      return active ? { runId: active.runId, kind: active.kind, startedAt: active.startedAt } : null;
    },

    waitForExit(runId) {
      const waiter = waiters.get(runId);
      if (!waiter) return Promise.reject(new Error(`Unknown run ${runId}`));
      return waiter();
    }
  };
}
```

Note: hoist `const waiters = new Map();` to the top of `createRunner` alongside `let active = null;` so both closures can reach it.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- web-runner 2>&1 | tail -15`
Expected: PASS, 9 tests

- [ ] **Step 6: Commit**

```bash
git add web/runner.js __tests__/web-runner.test.js __tests__/fixtures/
git commit -m "Add subprocess runner with single-run lock and crash-safe release"
```

---

### Task 7: Settings

**Files:**
- Create: `web/settings.js`
- Test: `__tests__/web-settings.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces:
  - `EDITABLE_ENV: Record<string, {type:'int'|'float', min:number, max:number}>`
  - `readSettings(projectDir: string): { accounts, env, secrets }`
  - `writeSettings(projectDir: string, patch: { accounts?, env? }): { accounts, env, secrets }` — throws on validation failure, writes atomically
  - `updateEnvText(text: string, updates: Record<string,string>): string` (exported for tests)

- [ ] **Step 1: Write the failing test**

```js
// __tests__/web-settings.test.js
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readSettings, writeSettings, updateEnvText, EDITABLE_ENV } from '../web/settings.js';

let dir;

const accountsFixture = {
  categories: {
    clubs: { description: 'Student clubs', enabled: true, accounts: ['msjbio', 'msjchemclub'] },
    asb: { description: 'ASB', enabled: true, accounts: ['msjhsac'] },
    old: { description: 'Disbanded', enabled: false, accounts: ['gone'] }
  },
  settings: { defaultCategory: 'clubs' }
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-settings-'));
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify(accountsFixture, null, 2));
  fs.writeFileSync(path.join(dir, '.env'), [
    '# Hermes configuration',
    'APIFY_TOKEN=apify_api_secret',
    'ANTHROPIC_API_KEY=sk-ant-secret',
    'START_DAYS_AGO=7',
    '# END_DATE=',
    'MAX_CLUBS_TO_PROCESS=100',
    ''
  ].join('\n'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('readSettings', () => {
  it('returns accounts, editable env values, and secret presence only', () => {
    const settings = readSettings(dir);

    expect(settings.accounts.categories.clubs.accounts).toEqual(['msjbio', 'msjchemclub']);
    expect(settings.env.START_DAYS_AGO).toBe('7');

    // The whole point of the allowlist: a UI bug cannot leak what it never reads.
    expect(settings.secrets).toEqual({
      APIFY_TOKEN: 'set',
      ANTHROPIC_API_KEY: 'set',
      GOOGLE_SPREADSHEET_ID: 'missing'
    });
    expect(JSON.stringify(settings)).not.toContain('apify_api_secret');
    expect(JSON.stringify(settings)).not.toContain('sk-ant-secret');
  });
});

describe('writeSettings', () => {
  it('adds and removes accounts', () => {
    writeSettings(dir, {
      accounts: { categories: { ...accountsFixture.categories,
        clubs: { ...accountsFixture.categories.clubs, accounts: ['msjbio', 'msjrobotics'] } } }
    });

    const written = JSON.parse(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf-8'));
    expect(written.categories.clubs.accounts).toEqual(['msjbio', 'msjrobotics']);
    expect(written.settings.defaultCategory).toBe('clubs');   // untouched keys survive
  });

  it('rejects a handle that is not a valid Instagram username', () => {
    expect(() => writeSettings(dir, {
      accounts: { categories: { clubs: { enabled: true, accounts: ['not a handle!'] } } }
    })).toThrow(/invalid handle/i);
  });

  it('rejects duplicate handles across categories', () => {
    expect(() => writeSettings(dir, {
      accounts: { categories: {
        clubs: { enabled: true, accounts: ['msjbio'] },
        asb: { enabled: true, accounts: ['msjbio'] }
      } }
    })).toThrow(/duplicate/i);
  });

  it('updates an allowlisted env value in place', () => {
    writeSettings(dir, { env: { START_DAYS_AGO: '14' } });

    const text = fs.readFileSync(path.join(dir, '.env'), 'utf-8');
    expect(text).toContain('START_DAYS_AGO=14');
    expect(text).toContain('# Hermes configuration');       // comments preserved
    expect(text).toContain('APIFY_TOKEN=apify_api_secret');  // secrets untouched
  });

  it('refuses to write a key that is not on the allowlist', () => {
    expect(() => writeSettings(dir, { env: { APIFY_TOKEN: 'stolen' } }))
      .toThrow(/not editable/i);
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf-8')).toContain('apify_api_secret');
  });

  it('range-checks numeric values', () => {
    expect(() => writeSettings(dir, { env: { START_DAYS_AGO: '-1' } })).toThrow(/between/i);
    expect(() => writeSettings(dir, { env: { START_DAYS_AGO: 'soon' } })).toThrow(/whole number/i);
  });

  it('leaves no partial file behind on a validation failure', () => {
    const before = fs.readFileSync(path.join(dir, 'accounts.json'), 'utf-8');
    expect(() => writeSettings(dir, {
      accounts: { categories: { clubs: { enabled: true, accounts: ['bad handle'] } } }
    })).toThrow();

    expect(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf-8')).toBe(before);
    expect(fs.readdirSync(dir).filter(f => f.includes('.tmp'))).toEqual([]);
  });
});

describe('updateEnvText', () => {
  it('replaces an existing assignment without touching anything else', () => {
    const text = 'A=1\n# comment\nB=2\n';
    expect(updateEnvText(text, { B: '9' })).toBe('A=1\n# comment\nB=9\n');
  });

  it('appends a key that is only present commented out', () => {
    // Rewriting the commented line would leave the setting looking disabled
    // while actually being live.
    const text = '# START_DAYS_AGO=7\n';
    expect(updateEnvText(text, { START_DAYS_AGO: '14' }))
      .toBe('# START_DAYS_AGO=7\nSTART_DAYS_AGO=14\n');
  });

  it('appends a key that is absent entirely', () => {
    expect(updateEnvText('A=1\n', { B: '2' })).toBe('A=1\nB=2\n');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- web-settings 2>&1 | tail -10`
Expected: FAIL — `Cannot find module '../web/settings.js'`

- [ ] **Step 3: Implement**

```js
// web/settings.js
//
// The web layer can edit operational knobs and the account list. It cannot read
// or write secrets - not because the UI is careless today, but because an
// allowlist is the only version of this that stays safe after the dashboard is
// deployed somewhere with a URL.
import fs from 'fs';
import path from 'path';

export const EDITABLE_ENV = {
  START_DAYS_AGO:       { type: 'int',   min: 0,    max: 365 },
  MAX_CLUBS_TO_PROCESS: { type: 'int',   min: 1,    max: 1000 },
  MAX_CAROUSEL_IMAGES:  { type: 'int',   min: 1,    max: 20 },
  APIFY_RESULTS_LIMIT:  { type: 'int',   min: 1,    max: 200 },
  APIFY_MAX_CHARGE_USD: { type: 'float', min: 0.01, max: 100 }
};

const REPORTED_SECRETS = ['APIFY_TOKEN', 'ANTHROPIC_API_KEY', 'GOOGLE_SPREADSHEET_ID'];
const HANDLE = /^[A-Za-z0-9._]{1,30}$/;

function envPath(dir)      { return path.join(dir, '.env'); }
function accountsPath(dir) { return path.join(dir, 'accounts.json'); }

function readEnvText(dir) {
  return fs.existsSync(envPath(dir)) ? fs.readFileSync(envPath(dir), 'utf-8') : '';
}

function parseEnv(text) {
  const values = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (match) values[match[1]] = match[2].trim();
  }
  return values;
}

export function updateEnvText(text, updates) {
  let result = text;

  for (const [key, value] of Object.entries(updates)) {
    const assignment = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');

    if (assignment.test(result)) {
      result = result.replace(assignment, `${key}=${value}`);
    } else {
      // A commented-out key stays commented: rewriting it in place would leave
      // the file reading as "disabled" while the value was actually live.
      if (!result.endsWith('\n') && result !== '') result += '\n';
      result += `${key}=${value}\n`;
    }
  }

  return result;
}

function writeAtomic(file, contents) {
  // Same directory, so the rename is atomic on the same filesystem. A crash
  // mid-write leaves the original intact rather than a truncated accounts.json.
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, contents);
  fs.renameSync(temp, file);
}

function validateAccounts(accounts) {
  if (!accounts || typeof accounts !== 'object' || !accounts.categories) {
    throw new Error('accounts must have a "categories" object');
  }

  const seen = new Map();

  for (const [name, category] of Object.entries(accounts.categories)) {
    if (!Array.isArray(category.accounts)) {
      throw new Error(`Category "${name}" is missing an accounts array`);
    }

    for (const handle of category.accounts) {
      if (typeof handle !== 'string' || !HANDLE.test(handle)) {
        throw new Error(`Invalid handle "${handle}" in category "${name}"`);
      }

      const key = handle.toLowerCase();
      if (seen.has(key)) {
        throw new Error(`Duplicate handle "${handle}" in "${name}" and "${seen.get(key)}"`);
      }
      seen.set(key, name);
    }
  }
}

function validateEnv(updates) {
  const clean = {};

  for (const [key, raw] of Object.entries(updates)) {
    const rule = EDITABLE_ENV[key];
    if (!rule) throw new Error(`${key} is not editable from the web UI`);

    const value = String(raw).trim();
    const number = rule.type === 'int' ? Number(value) : Number.parseFloat(value);

    if (!Number.isFinite(number)) {
      throw new Error(`${key} must be a ${rule.type === 'int' ? 'whole number' : 'number'}`);
    }
    if (rule.type === 'int' && !Number.isInteger(number)) {
      throw new Error(`${key} must be a whole number`);
    }
    if (number < rule.min || number > rule.max) {
      throw new Error(`${key} must be between ${rule.min} and ${rule.max}`);
    }

    clean[key] = value;
  }

  return clean;
}

export function readSettings(projectDir) {
  const accounts = JSON.parse(fs.readFileSync(accountsPath(projectDir), 'utf-8'));
  const parsed = parseEnv(readEnvText(projectDir));

  const env = {};
  for (const key of Object.keys(EDITABLE_ENV)) {
    if (parsed[key] !== undefined) env[key] = parsed[key];
  }

  const secrets = {};
  for (const key of REPORTED_SECRETS) {
    secrets[key] = parsed[key] ? 'set' : 'missing';
  }

  return { accounts, env, secrets };
}

export function writeSettings(projectDir, patch = {}) {
  // Validate everything before writing anything, so a bad handle in the third
  // category cannot leave .env updated and accounts.json not.
  if (patch.accounts) validateAccounts(patch.accounts);
  const envUpdates = patch.env ? validateEnv(patch.env) : null;

  if (patch.accounts) {
    const existing = JSON.parse(fs.readFileSync(accountsPath(projectDir), 'utf-8'));
    const merged = { ...existing, ...patch.accounts };
    writeAtomic(accountsPath(projectDir), JSON.stringify(merged, null, 2) + '\n');
  }

  if (envUpdates && Object.keys(envUpdates).length > 0) {
    writeAtomic(envPath(projectDir), updateEnvText(readEnvText(projectDir), envUpdates));
  }

  return readSettings(projectDir);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- web-settings 2>&1 | tail -10`
Expected: PASS, 11 tests

- [ ] **Step 5: Commit**

```bash
git add web/settings.js __tests__/web-settings.test.js
git commit -m "Add allowlisted, atomic settings reads and writes"
```

---

### Task 8: HTTP server

**Files:**
- Create: `web/server.js`
- Test: `__tests__/web-server.test.js`

**Interfaces:**
- Consumes: `createEventHub` (Task 5), `createRunner` (Task 6), `readRuns` (Task 4), `readSettings`/`writeSettings` (Task 7)
- Produces: `createServer({ projectDir, dataDir, runner, hub, storyDir })` → Node `http.Server` (not yet listening); `startServer({ port, host, ...})` → `Promise<http.Server>`

- [ ] **Step 1: Write the failing test**

```js
// __tests__/web-server.test.js
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createEventHub } from '../web/events.js';
import { createServer } from '../web/server.js';

let dir, hub, server, base, fakeRunner, started;

const fixtureAccounts = {
  categories: { clubs: { enabled: true, accounts: ['msjbio'] } },
  settings: { defaultCategory: 'clubs' }
};

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-server-'));
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify(fixtureAccounts));
  fs.writeFileSync(path.join(dir, '.env'), 'START_DAYS_AGO=7\nAPIFY_TOKEN=secret\n');

  hub = createEventHub();
  started = [];
  fakeRunner = {
    active: null,
    start(options) {
      if (this.active) {
        const error = new Error('busy');
        error.code = 'RUN_IN_PROGRESS';
        error.runId = this.active.runId;
        throw error;
      }
      started.push(options);
      this.active = { runId: 'run-1', kind: options.kind, startedAt: 1000 };
      return { runId: 'run-1' };
    },
    cancel(runId) { if (this.active?.runId === runId) { this.active = null; return true; } return false; },
    getActive() { return this.active; }
  };

  server = createServer({ projectDir: dir, dataDir: dir, storyDir: dir, runner: fakeRunner, hub });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the web server', () => {
  it('reports idle state', async () => {
    const body = await (await fetch(`${base}/api/state`)).json();
    expect(body.active).toBeNull();
    expect(body.accounts).toBe(1);
  });

  it('starts a scrape run', async () => {
    const response = await fetch(`${base}/api/runs`, { method: 'POST' });
    expect(response.status).toBe(201);
    expect((await response.json()).runId).toBe('run-1');
    expect(started[0]).toMatchObject({ kind: 'scrape', script: 'main.js' });
  });

  it('refuses a concurrent run with 409 and names the active one', async () => {
    await fetch(`${base}/api/runs`, { method: 'POST' });
    const response = await fetch(`${base}/api/runs`, { method: 'POST' });

    expect(response.status).toBe(409);
    expect((await response.json()).activeRunId).toBe('run-1');
  });

  it('starts a story run for a given date', async () => {
    const response = await fetch(`${base}/api/story`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ date: '2026-08-12' })
    });

    expect(response.status).toBe(201);
    expect(started[0]).toMatchObject({ kind: 'story', script: 'story.js', args: ['--date=2026-08-12'] });
  });

  it('rejects a malformed story date instead of passing it to the shell', async () => {
    const response = await fetch(`${base}/api/story`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ date: '2026-08-12; rm -rf /' })
    });

    expect(response.status).toBe(400);
    expect(started).toHaveLength(0);
  });

  it('returns a run snapshot built from the buffer', async () => {
    hub.publish('run-1', { t: 'run:config', accounts: 85 });
    hub.publish('run-1', { t: 'club:done', index: 1, total: 85, account: 'msjbio', postsFound: 2, eventsExtracted: 1 });

    const body = await (await fetch(`${base}/api/runs/run-1`)).json();
    expect(body.events).toHaveLength(2);
    expect(body.lastSeq).toBe(2);
  });

  it('cancels a run', async () => {
    await fetch(`${base}/api/runs`, { method: 'POST' });
    const response = await fetch(`${base}/api/runs/run-1/cancel`, { method: 'POST' });

    expect(response.status).toBe(200);
    expect(fakeRunner.getActive()).toBeNull();
  });

  it('never exposes secret values through settings', async () => {
    const body = await (await fetch(`${base}/api/settings`)).json();

    expect(body.secrets.APIFY_TOKEN).toBe('set');
    expect(JSON.stringify(body)).not.toContain('secret\n');
    expect(body.env.APIFY_TOKEN).toBeUndefined();
  });

  it('rejects a settings write outside the allowlist', async () => {
    const response = await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ env: { APIFY_TOKEN: 'stolen' } })
    });

    expect(response.status).toBe(400);
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf-8')).toContain('APIFY_TOKEN=secret');
  });

  it('refuses to serve a story image outside the story directory', async () => {
    const response = await fetch(`${base}/api/story/2026-08-12/..%2F..%2F.env`);
    expect(response.status).toBe(400);
  });

  it('404s an unknown route', async () => {
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- web-server 2>&1 | tail -10`
Expected: FAIL — `Cannot find module '../web/server.js'`

- [ ] **Step 3: Implement**

```js
// web/server.js
//
// Eight routes and a static directory do not need a framework, and not having
// one keeps package.json honest about what this actually depends on.
//
// Binds 127.0.0.1 only. There is no auth, and this process can spend money.
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { readRuns, runEventsPath } from './history.js';
import { readSettings, writeSettings } from './settings.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const STORY_FILE = /^story-\d{4}-\d{2}-\d{2}-p\d+\.png$/;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8'
};

function sendJson(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('Request body too large');
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch {
    throw new Error('Body must be valid JSON');
  }
}

function countAccounts(projectDir) {
  const { accounts } = readSettings(projectDir);
  return Object.values(accounts.categories)
    .filter(category => category.enabled !== false)
    .reduce((total, category) => total + (category.accounts?.length || 0), 0);
}

export function createServer({ projectDir, dataDir, storyDir, runner, hub }) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = `${req.method} ${url.pathname}`;

    try {
      if (route === 'GET /api/state') {
        return sendJson(res, 200, {
          active: runner.getActive(),
          accounts: countAccounts(projectDir),
          lastRun: readRuns(dataDir, { limit: 1, activeRunId: runner.getActive()?.runId })[0] || null
        });
      }

      if (route === 'POST /api/runs') {
        try {
          return sendJson(res, 201, runner.start({ kind: 'scrape', script: 'main.js' }));
        } catch (error) {
          if (error.code === 'RUN_IN_PROGRESS') {
            return sendJson(res, 409, { error: error.message, activeRunId: error.runId });
          }
          throw error;
        }
      }

      if (route === 'POST /api/story') {
        const { date } = await readBody(req);
        if (date !== undefined && !ISO_DATE.test(String(date))) {
          return sendJson(res, 400, { error: 'date must be YYYY-MM-DD' });
        }

        try {
          const args = date ? [`--date=${date}`] : [];
          return sendJson(res, 201, runner.start({ kind: 'story', script: 'story.js', args }));
        } catch (error) {
          if (error.code === 'RUN_IN_PROGRESS') {
            return sendJson(res, 409, { error: error.message, activeRunId: error.runId });
          }
          throw error;
        }
      }

      if (route === 'GET /api/history') {
        const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 500);
        return sendJson(res, 200, {
          runs: readRuns(dataDir, { limit, activeRunId: runner.getActive()?.runId })
        });
      }

      const runMatch = url.pathname.match(/^\/api\/runs\/([A-Za-z0-9_-]+)(\/stream|\/cancel)?$/);
      if (runMatch) {
        const [, runId, suffix] = runMatch;

        if (req.method === 'GET' && !suffix) {
          const events = hub.getBuffer(runId);
          if (events.length === 0 && fs.existsSync(runEventsPath(dataDir, runId))) {
            // A finished run has aged out of memory; replay it from disk.
            const replayed = fs.readFileSync(runEventsPath(dataDir, runId), 'utf-8')
              .split('\n').filter(Boolean).map(line => JSON.parse(line));
            return sendJson(res, 200, { events: replayed, lastSeq: replayed.at(-1)?.seq || 0 });
          }
          return sendJson(res, 200, { events, lastSeq: events.at(-1)?.seq || 0 });
        }

        if (req.method === 'GET' && suffix === '/stream') {
          hub.subscribe(runId, res, { lastEventId: req.headers['last-event-id'] });
          return;
        }

        if (req.method === 'POST' && suffix === '/cancel') {
          return sendJson(res, 200, { cancelled: runner.cancel(runId) });
        }
      }

      if (route === 'GET /api/settings') {
        return sendJson(res, 200, readSettings(projectDir));
      }

      if (route === 'PUT /api/settings') {
        try {
          return sendJson(res, 200, writeSettings(projectDir, await readBody(req)));
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }

      const storyList = url.pathname.match(/^\/api\/story\/(\d{4}-\d{2}-\d{2})$/);
      if (req.method === 'GET' && storyList) {
        const files = fs.existsSync(storyDir)
          ? fs.readdirSync(storyDir).filter(name => name.startsWith(`story-${storyList[1]}-p`)).sort()
          : [];
        return sendJson(res, 200, { date: storyList[1], files });
      }

      const storyFile = url.pathname.match(/^\/api\/story\/(\d{4}-\d{2}-\d{2})\/(.+)$/);
      if (req.method === 'GET' && storyFile) {
        const name = decodeURIComponent(storyFile[2]);
        if (!STORY_FILE.test(name)) {
          return sendJson(res, 400, { error: 'Not a story image name' });
        }

        const file = path.join(storyDir, name);
        if (!fs.existsSync(file)) return sendJson(res, 404, { error: 'Not found' });

        res.writeHead(200, { 'Content-Type': 'image/png' });
        return fs.createReadStream(file).pipe(res);
      }

      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const file = path.join(PUBLIC_DIR, name);

        if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file)) {
          return sendJson(res, 404, { error: 'Not found' });
        }

        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        return fs.createReadStream(file).pipe(res);
      }

      return sendJson(res, 404, { error: 'Not found' });

    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { error: error.message });
    }
  });
}

export function startServer({ port = 4317, host = '127.0.0.1', ...options }) {
  const server = createServer(options);

  return new Promise((resolve, reject) => {
    server.once('error', (error) => {
      reject(error.code === 'EADDRINUSE'
        ? new Error(`Port ${port} is already in use. Set PORT to something else.`)
        : error);
    });
    server.listen(port, host, () => resolve(server));
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- web-server 2>&1 | tail -15`
Expected: PASS, 11 tests

- [ ] **Step 5: Commit**

```bash
git add web/server.js __tests__/web-server.test.js
git commit -m "Add web server routes with path and payload validation"
```

---

### Task 9: Instrument the pipeline

**Files:**
- Modify: `main.js` (imports, plus lines 124, 133, 152, 166, 174)
- Modify: `scraping-orchestrator.js` (imports, plus the `processSequentially` loop at lines 46-94)
- Modify: `story.js` (imports, plus lines 83, 93, 104, 107)
- Test: `__tests__/orchestrator-progress.test.js`

**Interfaces:**
- Consumes: `emit`, `setSink`, `resetSink` from `utils/progress-events.js` (Task 2)
- Produces: the event stream consumed by `web/runner.js` (Task 6)

- [ ] **Step 1: Write the failing test**

```js
// __tests__/orchestrator-progress.test.js
import { jest } from '@jest/globals';
import { setSink, resetSink } from '../utils/progress-events.js';
import { ScrapingOrchestrator } from '../scraping-orchestrator.js';

describe('orchestrator progress events', () => {
  let events;

  beforeEach(() => {
    events = [];
    process.env.HERMES_PROGRESS = 'json';
    setSink(line => events.push(JSON.parse(line)));
  });

  afterEach(() => {
    resetSink();
    delete process.env.HERMES_PROGRESS;
  });

  const orchestratorFor = (scrapeClubPosts) => new ScrapingOrchestrator({
    config: { startDate: new Date('2026-08-05'), endDate: new Date('2026-08-12'), delayBetweenClubs: 0 },
    anthropic: {},
    progress: { processedClubs: [], processedPosts: [], failedClubs: [] },
    existingPostUrls: new Set(),
    needsPacing: false,
    scrapeClubPosts
  });

  it('emits a start and a done event per club', async () => {
    const orchestrator = orchestratorFor(async () => ({
      newPosts: [], stoppedAt: null, totalScraped: 4, duplicatesSkipped: 1, dateChecksSkipped: 0
    }));

    await orchestrator.processSequentially(['msjbio', 'msjchemclub'], null);

    expect(events.map(e => e.t)).toEqual([
      'club:start', 'club:done', 'club:start', 'club:done'
    ]);
    expect(events[0]).toMatchObject({ index: 1, total: 2, account: 'msjbio' });
    expect(events[1]).toMatchObject({ account: 'msjbio', postsFound: 4, eventsExtracted: 0 });
    expect(typeof events[1].durationMs).toBe('number');
  });

  it('emits club:error when a club fails', async () => {
    const orchestrator = orchestratorFor(async () => { throw new Error('Apify API 402'); });

    await orchestrator.processSequentially(['msjbio'], null);

    const error = events.find(e => e.t === 'club:error');
    expect(error).toMatchObject({ index: 1, total: 1, account: 'msjbio' });
    expect(error.message).toContain('402');
  });

  it('emits nothing when HERMES_PROGRESS is unset', async () => {
    delete process.env.HERMES_PROGRESS;
    const orchestrator = orchestratorFor(async () => ({
      newPosts: [], stoppedAt: null, totalScraped: 0, duplicatesSkipped: 0, dateChecksSkipped: 0
    }));

    await orchestrator.processSequentially(['msjbio'], null);
    expect(events).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- orchestrator-progress 2>&1 | tail -10`
Expected: FAIL — received `[]` instead of the four events

- [ ] **Step 3: Instrument the orchestrator**

In `scraping-orchestrator.js`, add to the imports:

```js
import { emit } from './utils/progress-events.js';
```

Then in `processSequentially`, wrap the `processClub` call (currently lines 58-69):

```js
      emit('club:start', { index: i + 1, total: clubs.length, account: clubUsername });
      const clubStartedAt = Date.now();

      const result = await processClub({
        page,
        clubUsername,
        startDate,
        endDate,
        existingPostUrls: this.existingPostUrls,
        anthropic: this.anthropic,
        progress: this.progress,
        resumeMode,
        metrics: this.metrics,
        scrapeClubPosts: this.scrapeClubPosts
      });

      if (result.success) {
        emit('club:done', {
          index: i + 1,
          total: clubs.length,
          account: clubUsername,
          postsFound: result.stats?.totalScraped ?? 0,
          eventsExtracted: result.results?.length ?? 0,
          durationMs: Date.now() - clubStartedAt
        });
      } else {
        emit('club:error', {
          index: i + 1,
          total: clubs.length,
          account: clubUsername,
          message: result.error || 'unknown error'
        });
      }
```

The existing `if (result.success) { ... } else { ... }` block below stays exactly as it is — this is an addition, not a replacement.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- orchestrator-progress 2>&1 | tail -10`
Expected: PASS, 3 tests

- [ ] **Step 5: Instrument main.js**

Add to the imports:

```js
import { emit } from './utils/progress-events.js';
```

After `metrics.setTotalClubs(clubsToProcess.length);` (line 124):

```js
    emit('run:config', {
      accounts: clubsToProcess.length,
      startDate: config.startDateStr,
      endDate: config.endDateStr,
      backend: scraperBackend.name
    });
```

Before `if (scraperBackend.prefetch)` (line 133): `emit('phase', { name: 'prefetch' });`

Before the `let results;` block (line 152): `emit('phase', { name: 'process' });`

Replace the sheet-writing block (lines 166-171) with:

```js
    if (results.length > 0) {
      emit('phase', { name: 'write' });
      const stats = await sheetsManager.writeResults(results);
      emit('sheet:write', {
        updated: stats?.updated ?? 0,
        appended: stats?.appended ?? 0,
        skipped: stats?.skipped ?? 0
      });
      await sheetsManager.sortByDate();
    } else {
      console.log('\n⚠️  No meeting data to write to spreadsheet');
      emit('sheet:write', { updated: 0, appended: 0, skipped: 0 });
    }
```

After `metrics.saveRunLog(...)` (line 174): `emit('summary', { summary: metrics.getSummary() });`

- [ ] **Step 6: Instrument story.js**

Add to the imports:

```js
import { emit } from './utils/progress-events.js';
```

Before `const events = sortEvents(...)` (line 83): `emit('phase', { name: 'fetch' });`

Before `const pages = paginate(events);` (line 93): `emit('phase', { name: 'paginate' });`

Before `const images = await renderPages(html);` (line 104): `emit('phase', { name: 'render' });`

In the `if (events.length === 0)` branch (line 88-91), before the `return`:

```js
    emit('story:done', { date: isoDate, pages: 0, files: [] });
```

And in the `if (outDir)` branch, replace the write loop so it collects names:

```js
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    const written = [];
    for (const [i, buffer] of images.entries()) {
      const name = `story-${isoDate}-p${i + 1}.png`;
      const file = path.join(outDir, name);
      fs.writeFileSync(file, buffer);
      written.push(name);
      console.log(`  ${file}`);
    }
    emit('story:done', { date: isoDate, pages: written.length, files: written });
  } else {
```

- [ ] **Step 7: Verify the CLI is unchanged and the whole suite is green**

Run: `npm test 2>&1 | tail -5`
Expected: all suites pass

Run: `DRY_RUN=true npm start 2>&1 | tail -8`
Expected: identical output to before — `HERMES_PROGRESS` is unset, so every `emit` is a no-op

- [ ] **Step 8: Commit**

```bash
git add main.js scraping-orchestrator.js story.js __tests__/orchestrator-progress.test.js
git commit -m "Emit structured progress events from the pipeline"
```

---

### Task 10: UI state reducer

The risky part of a no-framework frontend is folding an event stream into view state. That logic lives in its own module so it can be unit-tested; DOM code stays thin enough to verify by eye.

**Files:**
- Create: `web/public/state.js`
- Test: `__tests__/web-state.test.js`

**Interfaces:**
- Produces:
  - `initialState(): State` where `State = { runId, kind, status, phase, accounts, clubsDone, clubsTotal, postsFound, eventsExtracted, errors: [], current, sheet, summary, log: [], lastSeq, story }`
  - `reduce(state: State, event: object): State` — pure, returns a new object
  - `reduceAll(state: State, events: object[]): State`

- [ ] **Step 1: Write the failing test**

```js
// __tests__/web-state.test.js
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

  it('collects club errors without stopping the run', () => {
    const state = run(
      { t: 'run:start', runId: 'r1', kind: 'scrape', seq: 1 },
      { t: 'club:error', index: 1, total: 2, account: 'msjbio', message: 'Apify 402', seq: 2 },
      { t: 'club:done', index: 2, total: 2, account: 'msjchemclub', postsFound: 1, eventsExtracted: 1, seq: 3 }
    );

    expect(state.errors).toEqual([{ account: 'msjbio', message: 'Apify 402' }]);
    expect(state.clubsDone).toBe(2);   // an errored club is still a club accounted for
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

  it('marks a failed run failed', () => {
    const state = run(
      { t: 'run:start', runId: 'r1', kind: 'scrape', seq: 1 },
      { t: 'run:end', ok: false, status: 'failed', exitCode: 1, stderr: 'out of credit', seq: 2 }
    );

    expect(state).toMatchObject({ status: 'failed', exitCode: 1, stderr: 'out of credit' });
  });

  it('caps the log so a long run cannot grow without bound', () => {
    const events = Array.from({ length: 600 }, (_, i) => ({ t: 'log', level: 'info', message: `line ${i}`, seq: i + 1 }));
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- web-state 2>&1 | tail -10`
Expected: FAIL — `Cannot find module '../web/public/state.js'`

- [ ] **Step 3: Implement**

```js
// web/public/state.js
//
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
      return { ...next,
        accounts: event.accounts, clubsTotal: event.accounts,
        startDate: event.startDate, endDate: event.endDate, backend: event.backend };

    case 'phase':
      return { ...next, phase: event.name };

    case 'club:start':
      return { ...next, current: event.account, clubsTotal: event.total || next.clubsTotal };

    case 'club:done':
      return { ...next,
        clubsDone: event.index,
        clubsTotal: event.total || next.clubsTotal,
        postsFound: next.postsFound + (event.postsFound || 0),
        eventsExtracted: next.eventsExtracted + (event.eventsExtracted || 0),
        current: null };

    case 'club:error':
      // A failed club still counts as accounted for, or the progress bar stalls
      // at 84/85 on a run that actually finished.
      return { ...next,
        clubsDone: event.index,
        clubsTotal: event.total || next.clubsTotal,
        errors: [...next.errors, { account: event.account, message: event.message }],
        current: null };

    case 'sheet:write':
      return { ...next, sheet: { updated: event.updated, appended: event.appended, skipped: event.skipped } };

    case 'summary':
      return { ...next, summary: event.summary };

    case 'story:done':
      return { ...next, story: { date: event.date, pages: event.pages, files: event.files } };

    case 'run:end':
      return { ...next,
        status: event.status || (event.ok ? 'ok' : 'failed'),
        durationMs: event.durationMs ?? null,
        exitCode: event.exitCode ?? null,
        stderr: event.stderr || null,
        current: null };

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- web-state 2>&1 | tail -10`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add web/public/state.js __tests__/web-state.test.js
git commit -m "Add tested pure reducer for web UI run state"
```

---

### Task 11: Frontend shell, Run tab, and entry point

**Files:**
- Create: `web/public/index.html`
- Create: `web/public/style.css`
- Create: `web/public/app.js`
- Create: `web/index.js`
- Modify: `package.json` (add the `web` script)
- Modify: `.gitignore` (ignore `runs.jsonl` and `runs/`)

**Interfaces:**
- Consumes: `initialState`, `reduce`, `reduceAll` (Task 10); every route from Task 8
- Produces: `npm run web`

- [ ] **Step 1: Write the server entry point**

```js
// web/index.js
//
//   npm run web            http://127.0.0.1:4317
//   PORT=8080 npm run web
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createEventHub } from './events.js';
import { createRunner } from './runner.js';
import { startServer } from './server.js';

dotenv.config();

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = path.join(projectDir, '.hermes');
const storyDir = process.env.STORY_OUT_DIR || path.join(projectDir, 'out');
const port = Number(process.env.PORT) || 4317;

const hub = createEventHub();
const runner = createRunner({ projectDir, dataDir, hub });

startServer({ port, projectDir, dataDir, storyDir, runner, hub })
  .then(() => {
    console.log(`Hermes dashboard  →  http://127.0.0.1:${port}`);
    console.log(`Stories from      →  ${storyDir}`);
  })
  .catch(error => {
    console.error(`\n❌ ${error.message}`);
    process.exit(1);
  });
```

- [ ] **Step 2: Write the HTML shell**

```html
<!-- web/public/index.html -->
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Hermes</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <header>
    <h1>Hermes</h1>
    <nav id="tabs">
      <button data-tab="run" class="active">Run</button>
      <button data-tab="history">History</button>
      <button data-tab="story">Story</button>
      <button data-tab="settings">Settings</button>
    </nav>
  </header>

  <main>
    <section id="tab-run" class="tab active">
      <div class="actions">
        <button id="start-run" class="primary">Run scrape</button>
        <button id="cancel-run" hidden>Cancel</button>
        <span id="run-status" class="status">idle</span>
      </div>

      <div class="bar"><div id="progress" class="fill"></div></div>
      <p id="progress-label">No run yet</p>

      <div class="tiles">
        <div class="tile"><span id="stat-clubs">0/0</span><label>Clubs</label></div>
        <div class="tile"><span id="stat-posts">0</span><label>Posts found</label></div>
        <div class="tile"><span id="stat-events">0</span><label>Events extracted</label></div>
        <div class="tile"><span id="stat-errors">0</span><label>Errors</label></div>
      </div>

      <div id="summary-card" hidden></div>
      <ul id="error-list"></ul>

      <details id="log-panel">
        <summary>Log</summary>
        <pre id="log"></pre>
      </details>
    </section>

    <section id="tab-history" class="tab"><table id="history-table"></table></section>

    <section id="tab-story" class="tab">
      <div class="actions">
        <input type="date" id="story-date">
        <button id="generate-story" class="primary">Generate story</button>
        <span id="story-status" class="status"></span>
      </div>
      <div id="story-pages"></div>
    </section>

    <section id="tab-settings" class="tab">
      <div id="settings-form"></div>
      <p id="settings-status" class="status"></p>
    </section>
  </main>

  <script type="module" src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 3: Write the stylesheet**

```css
/* web/public/style.css */
:root {
  --bg: #0f1115; --panel: #171a21; --line: #262b36;
  --text: #e6e8ee; --muted: #9aa3b2;
  --ok: #4ade80; --warn: #fbbf24; --bad: #f87171; --accent: #60a5fa;
}

* { box-sizing: border-box; }

body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
}

header {
  display: flex; align-items: center; gap: 24px;
  padding: 16px 24px; border-bottom: 1px solid var(--line);
}

h1 { font-size: 18px; margin: 0; letter-spacing: 0.02em; }

nav button {
  background: none; border: none; color: var(--muted);
  padding: 8px 12px; border-radius: 6px; cursor: pointer; font-size: 14px;
}
nav button.active { background: var(--panel); color: var(--text); }

main { padding: 24px; max-width: 900px; }
.tab { display: none; }
.tab.active { display: block; }

.actions { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }

button.primary {
  background: var(--accent); color: #08111f; border: none;
  padding: 10px 18px; border-radius: 6px; font-weight: 600; cursor: pointer;
}
button.primary:disabled { opacity: 0.5; cursor: default; }

.status { color: var(--muted); font-variant-numeric: tabular-nums; }
.status.running { color: var(--accent); }
.status.ok { color: var(--ok); }
.status.failed, .status.interrupted { color: var(--bad); }
.status.cancelled { color: var(--warn); }

.bar { height: 6px; background: var(--panel); border-radius: 3px; overflow: hidden; }
.fill { height: 100%; width: 0; background: var(--accent); transition: width 0.2s; }
#progress-label { color: var(--muted); font-size: 13px; margin: 8px 0 20px; }

.tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.tile { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px; }
.tile span { display: block; font-size: 22px; font-variant-numeric: tabular-nums; }
.tile label { color: var(--muted); font-size: 12px; }

#summary-card {
  margin-top: 20px; padding: 16px; background: var(--panel);
  border: 1px solid var(--line); border-radius: 8px;
}

#error-list { list-style: none; padding: 0; }
#error-list li {
  background: var(--panel); border-left: 3px solid var(--bad);
  padding: 8px 12px; margin: 6px 0; font-size: 13px;
}

details { margin-top: 24px; }
summary { cursor: pointer; color: var(--muted); }
pre {
  background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
  padding: 12px; max-height: 340px; overflow: auto; font-size: 12px; white-space: pre-wrap;
}

table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 10px; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-weight: 500; }
tbody tr { cursor: pointer; }
tbody tr:hover { background: var(--panel); }

#story-pages { display: flex; gap: 16px; flex-wrap: wrap; }
#story-pages figure { margin: 0; }
#story-pages img {
  width: 240px; border: 1px solid var(--line); border-radius: 8px; display: block;
}
#story-pages a { color: var(--accent); font-size: 12px; }

.field { margin-bottom: 14px; }
.field label { display: block; color: var(--muted); font-size: 12px; margin-bottom: 4px; }
.field input {
  background: var(--panel); border: 1px solid var(--line); color: var(--text);
  padding: 8px 10px; border-radius: 6px; width: 220px;
}
.handle { display: inline-flex; align-items: center; gap: 6px;
  background: var(--panel); border: 1px solid var(--line);
  border-radius: 999px; padding: 4px 10px; margin: 3px; font-size: 13px; }
.handle button { background: none; border: none; color: var(--muted); cursor: pointer; }
</style>
```

Note: remove the trailing `</style>` — that block is a `.css` file, not embedded HTML.

- [ ] **Step 4: Write the app shell and Run tab**

```js
// web/public/app.js
import { initialState, reduce, reduceAll } from './state.js';

let state = initialState();
let source = null;

const $ = (id) => document.getElementById(id);
const api = async (path, options) => {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `${response.status}`);
  return body;
};

// ---- tabs

for (const button of document.querySelectorAll('#tabs button')) {
  button.addEventListener('click', () => {
    for (const other of document.querySelectorAll('#tabs button')) other.classList.remove('active');
    for (const tab of document.querySelectorAll('.tab')) tab.classList.remove('active');
    button.classList.add('active');
    $(`tab-${button.dataset.tab}`).classList.add('active');

    if (button.dataset.tab === 'history') loadHistory();
    if (button.dataset.tab === 'settings') loadSettings();
  });
}

// ---- run tab

function renderRun() {
  const done = state.clubsDone;
  const total = state.clubsTotal || state.accounts || 0;
  const running = state.status === 'running';

  $('run-status').textContent = state.status;
  $('run-status').className = `status ${state.status}`;
  $('start-run').disabled = running;
  $('cancel-run').hidden = !running;

  $('progress').style.width = total ? `${Math.round((done / total) * 100)}%` : '0';
  $('progress-label').textContent = running
    ? `${state.phase || 'starting'}${state.current ? ` · @${state.current}` : ''}`
    : (state.status === 'idle' ? 'No run yet' : `Finished in ${Math.round((state.durationMs || 0) / 1000)}s`);

  $('stat-clubs').textContent = `${done}/${total}`;
  $('stat-posts').textContent = state.postsFound;
  $('stat-events').textContent = state.eventsExtracted;
  $('stat-errors').textContent = state.errors.length;

  $('error-list').innerHTML = state.errors
    .map(e => `<li><strong>@${e.account}</strong> — ${e.message}</li>`).join('');

  const card = $('summary-card');
  if (state.status === 'idle' || running) {
    card.hidden = true;
  } else {
    card.hidden = false;
    const sheet = state.sheet
      ? `${state.sheet.appended} added, ${state.sheet.updated} updated, ${state.sheet.skipped} unchanged`
      : 'nothing written';
    card.innerHTML = `
      <strong>Run ${state.status}</strong>
      <p>${state.eventsExtracted} event(s) from ${state.postsFound} post(s) across ${done} account(s).</p>
      <p>Sheet: ${sheet}</p>
      ${state.stderr ? `<pre>${state.stderr}</pre>` : ''}`;
  }

  $('log').textContent = state.log.map(l => l.message).join('\n');
  $('log').scrollTop = $('log').scrollHeight;
}

function subscribe(runId) {
  if (source) source.close();

  source = new EventSource(`/api/runs/${runId}/stream`);
  source.onmessage = (message) => {
    state = reduce(state, JSON.parse(message.data));
    renderRun();
    if (state.kind === 'story') renderStory();
    if (['ok', 'failed', 'cancelled'].includes(state.status)) {
      source.close();
      source = null;
    }
  };
}

$('start-run').addEventListener('click', async () => {
  try {
    const { runId } = await api('/api/runs', { method: 'POST' });
    state = initialState();
    subscribe(runId);
  } catch (error) {
    $('run-status').textContent = error.message;
    $('run-status').className = 'status failed';
  }
});

$('cancel-run').addEventListener('click', () => {
  if (state.runId) api(`/api/runs/${state.runId}/cancel`, { method: 'POST' }).catch(() => {});
});

// ---- boot: reattach to a run already in flight

async function boot() {
  const info = await api('/api/state');
  state = { ...initialState(), accounts: info.accounts };

  if (info.active) {
    const snapshot = await api(`/api/runs/${info.active.runId}`);
    state = reduceAll(state, snapshot.events);
    subscribe(info.active.runId);
  }

  renderRun();
  $('story-date').value = new Date().toLocaleDateString('en-CA');
  loadStory();
}

boot();
```

Note: `loadHistory`, `loadSettings`, `loadStory`, and `renderStory` are added in Tasks 12-14. Define them as empty functions now so `boot()` runs, and fill them in as each task lands.

- [ ] **Step 5: Wire up the npm script and gitignore**

In `package.json`, add to `scripts`:

```json
    "web": "node web/index.js",
```

In `.gitignore`, append:

```
# Web UI run data
.hermes/
```

- [ ] **Step 6: Verify the dashboard boots and a run streams**

Run: `npm run web`
Then in another shell: `curl -s http://127.0.0.1:4317/api/state`
Expected: `{"active":null,"accounts":85,"lastRun":null}`

Open `http://127.0.0.1:4317` and click **Run scrape**. Expected: the status flips to `running`, the phase label moves through `prefetch` → `process`, the club counter climbs toward 85, and the log fills. Stop it with **Cancel** to avoid a full paid run during development.

- [ ] **Step 7: Commit**

```bash
git add web/index.js web/public/ package.json .gitignore
git commit -m "Add web dashboard shell and live run view"
```

---

### Task 12: History tab

**Files:**
- Modify: `web/public/app.js`

**Interfaces:**
- Consumes: `GET /api/history`, `GET /api/runs/:id` (Task 8); `reduceAll` (Task 10)

- [ ] **Step 1: Implement the history view**

Replace the placeholder `loadHistory` in `web/public/app.js`:

```js
// ---- history tab

const fmtTime = (ms) => ms ? new Date(ms).toLocaleString() : '—';
const fmtDuration = (ms) => ms ? `${Math.round(ms / 1000)}s` : '—';

async function loadHistory() {
  const { runs } = await api('/api/history?limit=50');

  if (runs.length === 0) {
    $('history-table').innerHTML = '<tbody><tr><td>No runs yet.</td></tr></tbody>';
    return;
  }

  $('history-table').innerHTML = `
    <thead><tr>
      <th>Started</th><th>Kind</th><th>Status</th><th>Duration</th>
      <th>Clubs</th><th>Posts</th><th>Events</th>
    </tr></thead>
    <tbody>${runs.map(run => `
      <tr data-run="${run.id}">
        <td>${fmtTime(run.startedAt)}</td>
        <td>${run.kind}</td>
        <td class="status ${run.status}">${run.status}</td>
        <td>${fmtDuration(run.durationMs)}</td>
        <td>${run.summary?.clubsProcessed ?? '—'}</td>
        <td>${run.summary?.totalPostsScraped ?? '—'}</td>
        <td>${run.summary?.totalNewPostsAdded ?? '—'}</td>
      </tr>`).join('')}
    </tbody>`;

  for (const row of $('history-table').querySelectorAll('tr[data-run]')) {
    row.addEventListener('click', () => replayRun(row.dataset.run));
  }
}

async function replayRun(runId) {
  // Replaying into the Run tab reuses the whole live view rather than building a
  // second, subtly different renderer for finished runs.
  const { events } = await api(`/api/runs/${runId}`);
  state = reduceAll(initialState(), events);

  renderRun();
  document.querySelector('#tabs button[data-tab="run"]').click();
}
```

- [ ] **Step 2: Verify**

Run: `npm run web`, then open the History tab.
Expected: past runs listed newest first with status, duration, and counts. Clicking a row switches to the Run tab showing that run's final state, progress bar, errors, and log.

To confirm the interrupted path: start a run, kill the server with `Ctrl-C` mid-run, restart it, and open History. Expected: that run shows `interrupted`, not `running`.

- [ ] **Step 3: Commit**

```bash
git add web/public/app.js
git commit -m "Add run history with replay into the live run view"
```

---

### Task 13: Story tab

**Files:**
- Modify: `web/public/app.js`

**Interfaces:**
- Consumes: `POST /api/story`, `GET /api/story/:date`, `GET /api/story/:date/:file` (Task 8)

- [ ] **Step 1: Implement the story view**

Replace the placeholder `loadStory` / `renderStory` in `web/public/app.js`:

```js
// ---- story tab

async function loadStory() {
  const date = $('story-date').value;
  if (!date) return;

  const { files } = await api(`/api/story/${date}`);
  paintStory(date, files);
}

function renderStory() {
  if (state.story) paintStory(state.story.date, state.story.files);
  $('story-status').textContent = state.status === 'running'
    ? (state.phase || 'starting')
    : (state.story?.pages === 0 ? 'No events on this date' : '');
}

function paintStory(date, files) {
  if (!files || files.length === 0) {
    $('story-pages').innerHTML = '<p class="status">Nothing rendered for this date yet.</p>';
    return;
  }

  // Cache-bust so regenerating the same date visibly updates the preview.
  const stamp = Date.now();
  $('story-pages').innerHTML = files.map((file, i) => `
    <figure>
      <img src="/api/story/${date}/${encodeURIComponent(file)}?v=${stamp}" alt="Story page ${i + 1}">
      <figcaption><a href="/api/story/${date}/${encodeURIComponent(file)}" download="${file}">Download page ${i + 1}</a></figcaption>
    </figure>`).join('');
}

$('story-date').addEventListener('change', loadStory);

$('generate-story').addEventListener('click', async () => {
  try {
    $('generate-story').disabled = true;
    const { runId } = await api('/api/story', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ date: $('story-date').value })
    });

    state = initialState();
    subscribe(runId);
  } catch (error) {
    $('story-status').textContent = error.message;
  } finally {
    $('generate-story').disabled = false;
  }
});
```

- [ ] **Step 2: Verify**

Run: `npm run web`, open the Story tab, pick a date you know has events, click **Generate story**.
Expected: status shows `fetch` → `paginate` → `render`, then the rendered pages appear at story aspect ratio with working download links. Files also land in `STORY_OUT_DIR` exactly as `npm run story` writes them.

Pick a Sunday with no events. Expected: "No events on this date", no error, and no images — matching `story.js:88`.

- [ ] **Step 3: Commit**

```bash
git add web/public/app.js
git commit -m "Add story generation, preview, and download"
```

---

### Task 14: Settings tab

**Files:**
- Modify: `web/public/app.js`

**Interfaces:**
- Consumes: `GET /api/settings`, `PUT /api/settings` (Task 7, Task 8)

- [ ] **Step 1: Implement the settings view**

Replace the placeholder `loadSettings` in `web/public/app.js`:

```js
// ---- settings tab

const NUMERIC_FIELDS = [
  ['START_DAYS_AGO', 'Days to look back'],
  ['MAX_CLUBS_TO_PROCESS', 'Max accounts per run'],
  ['MAX_CAROUSEL_IMAGES', 'Carousel images sent to Claude'],
  ['APIFY_RESULTS_LIMIT', 'Posts fetched per account'],
  ['APIFY_MAX_CHARGE_USD', 'Apify cost ceiling (USD)']
];

let settings = null;

async function loadSettings() {
  settings = await api('/api/settings');
  paintSettings();
}

function paintSettings() {
  const categories = Object.entries(settings.accounts.categories).map(([name, category]) => `
    <div class="field">
      <label>
        <input type="checkbox" data-category="${name}" ${category.enabled === false ? '' : 'checked'}>
        ${name} — ${category.accounts.length} account(s)
      </label>
      <div>${category.accounts.map(handle => `
        <span class="handle">@${handle}
          <button data-remove="${handle}" data-from="${name}" title="Remove">×</button>
        </span>`).join('')}</div>
      <input type="text" placeholder="add handle + Enter" data-add="${name}">
    </div>`).join('');

  const secrets = Object.entries(settings.secrets)
    .map(([key, value]) => `<li>${key}: <span class="status ${value === 'set' ? 'ok' : 'failed'}">${value}</span></li>`)
    .join('');

  $('settings-form').innerHTML = `
    <h2>Accounts</h2>${categories}
    <h2>Run settings</h2>
    ${NUMERIC_FIELDS.map(([key, label]) => `
      <div class="field">
        <label for="env-${key}">${label}</label>
        <input id="env-${key}" data-env="${key}" value="${settings.env[key] ?? ''}">
      </div>`).join('')}
    <button id="save-settings" class="primary">Save</button>
    <h2>Secrets</h2>
    <p class="status">Edited in .env only — the dashboard never reads their values.</p>
    <ul>${secrets}</ul>`;

  $('save-settings').addEventListener('click', saveSettings);

  for (const button of $('settings-form').querySelectorAll('[data-remove]')) {
    button.addEventListener('click', () => {
      const category = settings.accounts.categories[button.dataset.from];
      category.accounts = category.accounts.filter(h => h !== button.dataset.remove);
      paintSettings();
    });
  }

  for (const input of $('settings-form').querySelectorAll('[data-add]')) {
    input.addEventListener('keydown', (keyEvent) => {
      if (keyEvent.key !== 'Enter') return;
      const handle = input.value.trim().replace(/^@/, '');
      if (!handle) return;

      settings.accounts.categories[input.dataset.add].accounts.push(handle);
      paintSettings();
    });
  }

  for (const box of $('settings-form').querySelectorAll('[data-category]')) {
    box.addEventListener('change', () => {
      settings.accounts.categories[box.dataset.category].enabled = box.checked;
    });
  }
}

async function saveSettings() {
  const env = {};
  for (const input of $('settings-form').querySelectorAll('[data-env]')) {
    if (input.value.trim() !== '') env[input.dataset.env] = input.value.trim();
  }

  try {
    settings = await api('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accounts: settings.accounts, env })
    });

    $('settings-status').textContent = 'Saved.';
    $('settings-status').className = 'status ok';
    paintSettings();
  } catch (error) {
    // The server validates before writing anything, so a rejected save left both
    // files untouched - say so rather than leaving the user guessing.
    $('settings-status').textContent = `${error.message} — nothing was saved.`;
    $('settings-status').className = 'status failed';
  }
}
```

- [ ] **Step 2: Verify**

Run: `npm run web`, open Settings.
Expected: every category with its handles, checkboxes reflecting `enabled`, the five numeric fields populated from `.env`, and secrets listed as `set`/`missing` with no values.

Add a handle, click Save, then check: `git diff accounts.json` shows only the new handle, and `.env` comments are intact. Enter `-1` in "Days to look back" and Save. Expected: `START_DAYS_AGO must be between 0 and 365 — nothing was saved`, and `.env` unchanged.

- [ ] **Step 3: Commit**

```bash
git add web/public/app.js
git commit -m "Add accounts and settings editor"
```

---

### Task 15: Documentation and final verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the dashboard**

Add a section to `README.md` after the existing usage instructions:

```markdown
## Web dashboard

    npm run web        # http://127.0.0.1:4317

Start a scrape, watch it live, browse past runs, generate and preview the daily
story, and edit tracked accounts.

The dashboard drives the same CLI entry points as a subprocess — it does not
reimplement the pipeline. `npm start` and `npm run story` behave identically
whether or not the dashboard is running.

Only one run happens at a time. A second start request is refused rather than
queued, since two concurrent runs would both spend Apify credits and race to
write the same sheet rows.

Run history lives in `.hermes/` (gitignored): `runs.jsonl` for summaries and
`runs/<id>.jsonl` for each run's full event stream, which is what lets a
finished run be replayed in the UI.

**It binds `127.0.0.1` only and has no authentication.** It can spend Apify and
Claude credits, so do not expose it to a network without adding auth first.
Secrets stay in `.env`; the web layer reports only whether each is set.
```

- [ ] **Step 2: Run the whole suite**

Run: `npm test 2>&1 | tail -6`
Expected: all suites pass, roughly 250 tests, zero failures

- [ ] **Step 3: Confirm the CLI is untouched**

Run: `DRY_RUN=true npm start 2>&1 | tail -8`
Expected: `✅ All validations passed!` with `Clubs Found: 85`

- [ ] **Step 4: End-to-end check against a small live run**

Set `MAX_CLUBS_TO_PROCESS=3` in `.env`, run `npm run web`, and click **Run scrape**. Expected: three clubs tick through, the sheet write reports counts, the summary card appears, and the run shows in History with status `ok`. Restore `MAX_CLUBS_TO_PROCESS=100` afterward.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "Document the web dashboard"
```

---

## Self-review

**Spec coverage.** Every spec section maps to a task: architecture → Tasks 2-8; event contract → Tasks 2, 3, 9; data flow → Tasks 5, 6; HTTP API → Task 8 (all eleven routes); the four screens → Tasks 11-14; error handling → Tasks 3 (partial/malformed lines), 4 (interrupted, corrupt lines), 5 (dead sockets, buffer cap), 6 (crash, lock release, cancel), 7 (allowlist, atomic write), 8 (path traversal, oversized body, port in use); testing → tests in Tasks 2-10; pre-existing fixes → Task 1.

**Placeholders.** None. Task 11 explicitly stubs four functions that Tasks 12-14 fill in, and says so.

**Type consistency.** `emit(t, payload)` is used identically in Tasks 2 and 9. `createEventHub` returns `publish`/`subscribe`/`getBuffer`/`clear`, consumed with those names in Tasks 6 and 8. `createRunner` returns `start`/`cancel`/`getActive`/`waitForExit`, matching the fake runner in Task 8's tests. `readRuns(dir, {limit, activeRunId})` is called with that shape in Task 8. `initialState`/`reduce`/`reduceAll` from Task 10 are used with those names in Tasks 11-13. The `status` values `idle|running|ok|failed|cancelled|interrupted` are consistent across Tasks 4, 6, 10, and the CSS in Task 11.

One known wrinkle carried deliberately: Task 6's `createRunner` needs `const waiters = new Map();` hoisted alongside `let active = null;`, called out in a note under the implementation step.
