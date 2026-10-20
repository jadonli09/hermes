# Rolling-Window Scrape Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the nightly scrape from permanently losing posts. Every night re-scans an overlapping multi-day window with a realistic per-club cap, and a night where Instagram blocks the scraper no longer moves the watermark forward or hides behind a warning that always appears.

**Architecture:** `fetchPlan` (automation/nightly.js) changes from "since last run, cap 1" to "rolling 4 Pacific days, widened back to the last *source-healthy* run, never more than 11 days". A new `sourceHealth(report)` in automation/coverage.js classifies a run as healthy when ≤25% of requested accounts are blocked. Pipeline activity (the watermark) is only recorded for healthy runs, and the delivery email warns only on unhealthy runs, with a specific message.

**Tech Stack:** Node.js ESM, Jest (`npm test`), Apify `apify/instagram-post-scraper`.

**Spec:** The investigation in this session (no separate spec file). Evidence:
- Oct 19 night: Apify log shows 88 profiles "reached maximum retries… Request got blocked". The coverage report marked 90 of 93 accounts `blocked`. Healthy nights (Oct 14–18) marked 0–4 `blocked`.
- MSJ Interact posted 3 posts Oct 19 (00:01Z, ~01:00Z, 01:37Z Oct 20). Cap 1 alone would have missed 2 of them.
- Oct 3–18 data: about 7% of posts were a club's second-or-later post in the same 9 PM–9 PM night.
- `.hermes/pipeline-activity.json` currently holds `coveredFrom: 2026-10-20T04:00:00.000Z` from the blocked Oct 19 job.

## Global Constraints

- `LOOKBACK_DAYS = 4`, `MAX_LOOKBACK_DAYS = 11`, `MIN_RESULTS_LIMIT = 8`, limit = `max(8, 2 × windowDays)`, `BLOCKED_RATIO_LIMIT = 0.25`.
- Nightly Apify budget stays ≤ $2 (existing check in runNightly). No new paid retries or extra actor starts.
- Existing in-progress jobs keep their saved `plan` (runNightly already prefers `saved?.plan`). Do not rewrite historical job files.
- Lunch display default in story/prepare-events.js is user-requested. Do not touch it.
- Run the full suite with `npm test`. All suites must pass before each commit.

## Review Focus

1. The stale v1 `pipeline-activity.json` written by the blocked Oct 19 job must not narrow the next window. Pinned by a test in Task 3.
2. Sunday night after skipped Fri/Sat nights must still overlap Thursday. Pinned in Task 2.
3. Playwright backend (no coverage report) on a manual `npm start` must still record activity. Pinned in Task 4.
4. A run blocked at exactly 25% counts as healthy, and 26% does not. Pinned in Task 1.
5. A job whose saved coverage report is missing must count as unhealthy, never healthy. Pinned in Task 1 (`sourceHealth(null)`).

---

### Task 1: `sourceHealth` classifier and blocked-run warning text

**Files:**
- Modify: `automation/coverage.js` (add exports below `classifyCoverage`)
- Test: `__tests__/coverage.test.js`

**Interfaces:**
- Produces: `export const BLOCKED_RATIO_LIMIT = 0.25`
- Produces: `export function sourceHealth(report) -> { healthy: boolean, blocked: number, requested: number }`. `blocked` counts accounts whose `reasons` include `'blocked'`, and `requested` = number of keys in `report.accounts`. `healthy = requested > 0 && blocked / requested <= BLOCKED_RATIO_LIMIT`. A null/undefined report or one without `accounts` → `{ healthy:false, blocked:0, requested:0 }`.
- Produces: `export function blockedWarning({ blocked, requested }, lookbackDays) -> string`, exactly:
  `` `Instagram blocked the scraper for ${blocked} of ${requested} clubs tonight, so their newest posts may be missing from these images. The next nightly run automatically re-checks at least the last ${lookbackDays} days.` ``

- [ ] **Step 1: Write failing tests** `sourceHealth` and `blockedWarning`:

```js
const acct = blocked => ({ status: blocked ? 'blocked' : 'observed-window', reasons: blocked ? ['blocked'] : [] });
const report = (b, total) => ({ accounts: Object.fromEntries(Array.from({ length: total }, (_, i) => [`a${i}`, acct(i < b)])) });
test('healthy night with a few blocked accounts', () => expect(sourceHealth(report(4, 93))).toEqual({ healthy: true, blocked: 4, requested: 93 }));
test('mass-blocked night is unhealthy', () => expect(sourceHealth(report(90, 93))).toEqual({ healthy: false, blocked: 90, requested: 93 }));
test('threshold is inclusive at 25%', () => { expect(sourceHealth(report(1, 4)).healthy).toBe(true); expect(sourceHealth(report(26, 100)).healthy).toBe(false); });
test('missing report is unhealthy', () => { expect(sourceHealth(null)).toEqual({ healthy: false, blocked: 0, requested: 0 }); expect(sourceHealth({}).healthy).toBe(false); });
test('ambiguous-empty and cap-reached do not count as blocked', () => expect(sourceHealth({ accounts: { a: { reasons: ['ambiguous-empty'] }, b: { reasons: ['cap-reached'] } } }).blocked).toBe(0));
test('blocked warning copy', () => expect(blockedWarning({ blocked: 90, requested: 93 }, 4)).toBe('Instagram blocked the scraper for 90 of 93 clubs tonight, so their newest posts may be missing from these images. The next nightly run automatically re-checks at least the last 4 days.'));
```

- [ ] **Step 2:** Run `npm test -- coverage` → FAIL (`sourceHealth` is not exported).
- [ ] **Step 3:** Implement both functions in `automation/coverage.js`.
- [ ] **Step 4:** Run `npm test -- coverage` → PASS.
- [ ] **Step 5:** Commit `feat: classify scrape runs as source-healthy or blocked`.

### Task 2: Rolling overlapping fetch window

**Files:**
- Modify: `automation/nightly.js` (`fetchPlan`, add exported constants)
- Test: `__tests__/nightly.test.js` (replace the cap-1/cap-3/eleven-day expectations at the existing `fetchPlan` tests, lines ~40–116), `__tests__/pipeline-activity.test.js` lines 32–41 (update expected limits)

**Interfaces:**
- Consumes: existing `slotFor`, `pacificInstant(date, hour=0)`, `addDays`, `localParts`.
- Produces: `export const LOOKBACK_DAYS = 4, MAX_LOOKBACK_DAYS = 11, MIN_RESULTS_LIMIT = 8`.
- Produces: `fetchPlan(slot, last, scope) -> { since: ISOString, limit: number, catchUp: boolean, reason: 'rolling'|'extended-after-gap'|'max-lookback'|'no-trusted-history', budgetUsd: 2 }`. Same signature as today.

Algorithm (not determined by the signature):
```
rolling = pacificInstant(addDays(slot.night, -(LOOKBACK_DAYS - 1)))      // Pacific midnight, 4 calendar days incl. tonight
floor   = pacificInstant(addDays(slot.night, -(MAX_LOOKBACK_DAYS - 1)))  // Pacific midnight, 11 days
trusted = last?.scope === scope ? last.coveredFrom : null                 // keep existing invalid-checkpoint throw
since   = !trusted ? floor : max(floor, min(rolling, trusted))            // earliest-wins, clamped to floor
windowDays = Pacific calendar days from dayOf(since) to slot.night, inclusive
limit   = max(MIN_RESULTS_LIMIT, 2 * windowDays)
reason  = !trusted ? 'no-trusted-history' : since === floor && trusted < floor ? 'max-lookback' : since < rolling ? 'extended-after-gap' : 'rolling'
catchUp = reason !== 'rolling'
```
Keep the existing "since ≥ scheduledAt → scheduledAt − 1 ms" guard.

- [ ] **Step 1: Write failing tests** (slot = `slotFor(new Date('2026-10-20T05:00:00Z'))`, Monday night 2026-10-19):

```js
test('normal night re-scans a rolling 4-day window', () =>
  expect(fetchPlan(slot, { scope: 'a', coveredFrom: '2026-10-19T04:00:00.000Z' }, 'a'))
    .toMatchObject({ since: '2026-10-16T07:00:00.000Z', limit: 8, catchUp: false, reason: 'rolling' }));
test('after a blocked or missed stretch the window widens back to the last healthy run', () =>
  expect(fetchPlan(slot, { scope: 'a', coveredFrom: '2026-10-14T04:00:00.000Z' }, 'a'))
    .toMatchObject({ since: '2026-10-14T04:00:00.000Z', limit: 14, catchUp: true, reason: 'extended-after-gap' }));
test('never looks back more than 11 days', () =>
  expect(fetchPlan(slot, { scope: 'a', coveredFrom: '2026-10-01T04:00:00.000Z' }, 'a'))
    .toMatchObject({ since: '2026-10-09T07:00:00.000Z', limit: 22, reason: 'max-lookback' }));
test('no history uses the 11-day window', () =>
  expect(fetchPlan(slot, null, 'a')).toMatchObject({ since: '2026-10-09T07:00:00.000Z', limit: 22, reason: 'no-trusted-history' }));
test('Sunday after skipped Fri/Sat still overlaps Thursday', () => {
  const sunday = slotFor(new Date('2026-10-19T05:00:00Z')); // night 2026-10-18
  expect(fetchPlan(sunday, { scope: 'a', coveredFrom: '2026-10-16T04:00:00.000Z' }, 'a'))
    .toMatchObject({ since: '2026-10-15T07:00:00.000Z', limit: 8, reason: 'rolling' });
});
```
Delete or rewrite the old tests asserting `limit` 1/3/4/6/11 and the `inactive-at-least-seven-days` reason.

- [ ] **Step 2:** Run `npm test -- nightly pipeline-activity` → new tests FAIL.
- [ ] **Step 3:** Rewrite `fetchPlan` per the algorithm.
- [ ] **Step 4:** Run `npm test` → all PASS.
- [ ] **Step 5:** Commit `fix: re-scan an overlapping 4-day window every night`.

### Task 3: Only source-healthy runs advance the watermark

**Files:**
- Modify: `automation/pipeline-activity.js` (`recordPipelineActivity`, `latestPipelineActivity`)
- Modify: `automation/nightly.js` (the block after refresh that calls `recordPipelineActivity`; store `job.sourceHealth`)
- Test: `__tests__/pipeline-activity.test.js`, `__tests__/nightly.test.js`

**Interfaces:**
- Consumes: `sourceHealth(report)` (Task 1).
- Produces: `recordPipelineActivity(projectDir, { startedAt, scope, summary, allAccountsProcessed, sourceHealthy, sourceJob? }) -> boolean`. Returns false unless `sourceHealthy === true`. Writes `{ version: 2, scope, coveredFrom, sourceHealthy: true, sourceJob? }`.
- Produces: `latestPipelineActivity(projectDir, scope)`. It ignores the saved file unless `version === 2 && sourceHealthy === true`, and ignores the legacy checkpoint (`latestRefresh`) entirely. In the job-directory scan, a job counts only if the existing checks pass **and** `sourceHealth(job.observedCoverageReport || job.coverageReport).healthy`.
- runNightly sets `job.sourceHealth = sourceHealth(observed)` and passes `sourceHealthy: job.sourceHealth.healthy`.

- [ ] **Step 1: Write failing tests**
  - `recordPipelineActivity` with `sourceHealthy:false` → returns false, file unchanged.
  - The poisoned-state reproduction: write `.hermes/pipeline-activity.json` = `{version:1,scope,coveredFrom:'2026-10-20T04:00:00.000Z',sourceJob:'2026-10-19'}`. Save job `2026-10-18` with a healthy report (4/93 blocked) and job `2026-10-19` with a 90/93-blocked report. Expect `latestPipelineActivity(root,scope).coveredFrom === pacificInstant('2026-10-18',21)`.
  - runNightly with a child whose coverage event reports 90/93 blocked: the job completes (images still render), `job.sourceHealth.healthy === false`, and `pipeline-activity.json` is not advanced.
- [ ] **Step 2:** `npm test -- pipeline-activity nightly` → FAIL.
- [ ] **Step 3:** Implement. Update `migratePipelineActivity` to write version 2 with `sourceHealthy: true` only when the found activity came from a healthy job.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `fix: blocked scrape nights no longer advance the coverage watermark`.

### Task 4: Manual `npm start` applies the same health gate

**Files:**
- Modify: `main.js` (the `recordPipelineActivity` call, ~line 238)
- Modify: `scrapers/apify-scraper.js` (strict-mode saturation message that still mentions the one-post-per-day assumption)
- Test: `__tests__/pipeline-activity.test.js` (unit on a small exported helper)

**Interfaces:**
- Produces: `export function manualSourceHealthy(backendName, coverageReport) -> boolean` in `automation/pipeline-activity.js`: `backendName !== 'apify' || sourceHealth(coverageReport).healthy`.
- main.js passes `sourceHealthy: manualSourceHealthy(scraperBackend.name, scraperBackend.getCoverage?.())`.

- [ ] **Step 1: Tests:** `manualSourceHealthy('playwright', undefined) === true`; `manualSourceHealthy('apify', report(90,93)) === false`; `manualSourceHealthy('apify', report(4,93)) === true`; `manualSourceHealthy('apify', undefined) === false`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement and wire it into main.js. Change the apify-scraper message to `` `${saturated.length} account(s) hit the per-run post cap; older posts in the window may be beyond it` ``. **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `fix: manual scrapes only advance the watermark when Instagram did not block them`.

### Task 5: Email warns only on blocked nights, with specific text

**Files:**
- Modify: `automation/connector-delivery.js` (`manifest()`)
- Modify: `automation/CONNECTOR-RUNBOOK.md`, `automation/README.md` ("Coverage and costs" section: replace the one-post-per-day/no-overlap policy with the rolling-window policy and the 25% blocked rule)
- Test: `__tests__/connector-delivery.test.js`

**Interfaces:**
- Consumes: `sourceHealth`, `blockedWarning` (Task 1), `LOOKBACK_DAYS` (Task 2).
- `manifest()` computes `health = job.sourceHealth || sourceHealth(job.observedCoverageReport || job.coverageReport)`.
  - healthy → subject `Hermes ${targetDate} [night-${id}]`, `requiredBodyText: ''`.
  - unhealthy → subject suffix `` ` — scrape blocked for ${health.blocked} of ${health.requested} clubs` ``, `requiredBodyText: blockedWarning(health, LOOKBACK_DAYS)`.
  - `coverage: { healthy, blocked, requested, gaps }`. Keep `gaps` as today.

- [ ] **Step 1: Tests:** a healthy job (4/93 blocked, other accounts `ambiguous-empty`) → subject has no suffix and `requiredBodyText === ''`. A 90/93 job → exact subject suffix and exact `blockedWarning` text.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement and update both docs. **Step 4:** `npm test` → PASS, `git diff --check` clean.
- [ ] **Step 5:** Commit `fix: nightly email warns only when Instagram blocked the scrape`.

### Task 6: Verify against real saved state (read-only)

- [ ] **Step 1:** Run `node automation/nightly.js` (plan-only; it never starts Apify). Outside 21:00–06:00 PT it prints `outside-window`. In that case run `node -e` with `fetchPlan(slotFor(new Date('2026-10-21T05:00:00Z')), latestPipelineActivity(process.cwd(), refreshScope(process.cwd())), refreshScope(process.cwd()))`. Expected: `since` ≤ `2026-10-17T07:00:00.000Z` and `limit ≥ 8`. It must not be the cap-1 Oct 20 04:00Z window.
- [ ] **Step 2:** Confirm no file under `.hermes/` changed (`git status` ignores `.hermes`, so compare `ls -lT .hermes/pipeline-activity.json` before and after).
- [ ] **Step 3:** Report the plan output to the user. Do not start a paid run.
