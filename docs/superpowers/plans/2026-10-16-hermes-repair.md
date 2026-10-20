# Hermes repair plan — 2026-10-16

Scope: saved October 15 Pacific run, October 16 story. Diagnosis established duplicate Relay kickoff, unknown times displayed as all-day, defaulted Aviation lunch, collaboration attribution omissions, and posting-rate assumptions conflated with retrieval failures.

## Invariants
Preserve dirty checkout work, historical artifacts, .hermes delivery/coverage state, 9pm Pacific Sunday–Thursday schedule, Sunday Friday–Sunday retrieval/Monday image, seven-day inactivity/eleven-day catch-up floor, $2 Apify maximum, separate Claude costs, exact warning text, and prepare/claim/send/ack/verify duplicate-send protections. No paid actors, messages, spreadsheet writes, credentials, or scheduler changes in this repair.

Baseline: /Users/jadonli/Documents/Codex/2026-10-13/task/hermes-repair-baseline-20261016/checkout.tar.gz contains tracked and nonignored untracked files before edits; durable-state-sha256.json records all .hermes files. Never restore runtime state over a later real run.

## Stages and acceptance gates
1. Read repository engineering/design guidance and preserve baseline. Keep one code owner; no invisible Claude process. No attached visible Claude terminal was available.
2. Add conservative presentation-only cross-post consolidation. Same club/date, compatible explicit times/rooms, distinctive shared event wording; ambiguous or conflicting candidates remain separate. Keep all source records and URLs. Do not delete or rewrite Sheet rows. Replace blank-time all-day labels with unknown-time labels; preserve contextual periods and explicit all-day. Remove extractor lunch defaults and version extraction cache. Apply narrowly guarded reviewed source corrections to known historical rows; never overwrite manual edits.
3. Report owner and coauthors as related-content evidence without granting profile traversal. Move posting-rate deviations into sizing advisories; cap saturation, blocked/empty/missing/absent/partial/unknown diagnostics remain unresolved. Replay October 15 data and prior fixtures.
4. Add an offline recovery planner: original gap dates retained; bounded batch and retry intervals, no replacement handles, no actor execution, no new budget. Missing handles require human evidence; quiet/blocked/absent profiles are deferred between probes. Saturated profiles require bounded review rather than automatic expansion. Existing normal scheduled scan policy is unchanged; extra recovery never launches automatically.
5. Isolated secret-free regression run including delivery tests, semantic false-merge tests, time tests, coverage/recovery fixtures. Read existing Sheet once for a saved preview fixture, render separate preview folder without production entry points, inspect PNGs, compare state hashes, document rollback and live-check limits.

## Review criteria
A corrected October 16 story has seven distinct events, one Relay lunch kickoff, freshmen health/ethnic-studies-period label, Aviation time unspecified, and retained source URLs. No inferred completeness for unknown profiles. Existing delivery tests and schedule/date policy tests pass. Report actual test totals and remaining external uncertainty; do not promise zero mistakes.

## Completed verification

All five stages completed. Final suite: 34 suites, 513 tests passed (32.955s), including existing connector/email/actor recovery/nightly tests. Initial full run found the obsolete strict rate-rejection expectation; it was updated to assert the new advisory policy while preserving account-error rejection. Review added pairwise component matching so an unknown-time row cannot bridge two separate sessions, and generic weekly meetings cannot merge.

Offline October 15 replay: 48 observed accounts, 45 unresolved gaps, four separate rate advisories. Gap distribution: 38 ambiguous-empty, four blocked, two absent-input, one missing handle. Owner/coauthor evidence does not clear profile gaps. No production coverage files were rewritten.

October 16 preview: eight source rows become seven events on one page. Relay appears once at Lunch with both source URLs; freshmen panel uses Health/ethnic studies period; Aviation uses Time not specified. Source Sheet rows remain unchanged. Preview is outside sent artifacts at /Users/jadonli/Documents/Codex/2026-10-13/task/hermes-oct16-repaired-preview. Its JSON sidecar retains all eight sources and reviewed correction originals. Visual inspection and measured layout: zero overflow; y=250..1670 card; GeneralSans, Satoshi, JBMono loaded.

All 111 .hermes files match baseline hashes, including sent images, job/delivery receipts, account coverage, cache and configuration. No paid actors, Claude API calls, new emails, Sheet writes, credential changes or schedule changes. Tests use a secret-free isolated checkout.

## Remaining limits and next run

Implementation is ready for the next existing scheduled run in qualified best-effort mode. External scraping uncertainties remain real; a successful actor is not proof of complete Instagram coverage. New extraction prompt behavior is unit-tested with mocked responses, but no paid model/actor run was started. The ordinary authorized next run is the first live integration check. Do not perform a paid verification run or correction email without new authorization.

The recovery planner is deliberately review-only and does not change normal nightly scanning. It proposes no immediate retries for current state: 48 accounts deferred for recent attempts/cache review, Data Science manual. Any future recovery execution requires a reviewed cost estimate and outstanding-intent check within the existing shared $2 cap; it must not receive a second $2 allowance. Claude spend remains separate.

Historical rows with earlier inferred times are not globally rewritten: only two source-reviewed, exact-match corrections were added. Other old inferred times may need evidence-based review. Conservative reconciliation can leave uncertain duplicates rather than merge distinct events. Calendar/Sheet source rows are retained; reconciliation is applied to story presentation.

## Rollback

Baseline and guarded rollback manifest/script are in /Users/jadonli/Documents/Codex/2026-10-13/task/hermes-repair-baseline-20261016. Run rollback.py without arguments to validate/show the repair-only file list. With explicit rollback authorization, run rollback.py --apply. It first verifies every current file against recorded post-repair hashes and aborts if later edits exist, then restores only this repair's changed files or removes its new files. Never use git reset/clean or overwrite .hermes; the baseline includes pre-existing uncommitted work and runtime state must be preserved. No commit or push was made.

## Focused final review

Existing Sheet URLs are skipped by scrapers/apify-scraper.js before club-processor calls cachedExtraction. Thus old Sheet events with inferred Lunch are not silently rewritten or charged for re-extraction. Extraction cache identity was bumped from v1 to v2: for a post not already represented in the Sheet, an old v1 result is not reused; the next authorized extraction uses the revised prompt, creates a v2 result, and subsequent retries reuse v2. Old cache bytes remain intact. This may incur a new Claude call for a still-unsaved old-cache post; Claude billing remains separate from Apify. There is no claim of blanket historical time repair.

The two historical exceptions live in story/reviewed-events.json. Each matches exact club, date, time, event type, room, post URL and description before applying its event_time patch. Aviation changes Lunch to blank after source artwork/caption review; freshmen panel changes blank to Health/ethnic studies period from its explicit caption. They apply only during story preparation, retaining correction reason and original row in the provenance sidecar. Source Sheet/cache/delivery artifacts are not modified. New dates/posts do not accidentally inherit these corrections.

Generic fixes apply to all future stories and extractions: conservative cross-post reconciliation, provenance, unknown/all-day/contextual time handling, owner/coauthor evidence and independent rate advisories. Reconciliation requires exact club identity (case/whitespace normalized, dots/underscores preserved), same normalized date, shared explicit room, compatible times/types, and a distinctive contiguous title. All members of a candidate group must match pairwise. Different clubs remain separate even on one collaborative post; different dates, rooms, times and ambiguous bridges remain separate. A review found and fixed punctuation-collapsing club identity; new tests cover that case.

Recurring settings are intentionally a separate manually maintained strip, or standalone events when no dated rows exist. They never pass through cross-post consolidation. Existing recurring validation/date/render tests remain in the full suite, and a new test preserves weekly occurrences on separate dates. This repair does not reconcile a manually configured standing meeting against a scraped announcement; such a match may need separate review.

The enabled cloud automation 6ace969a1034819193b1c41e1947a1c2 was read without modification. It targets /Users/jadonli/Downloads/Hermes and the current CONNECTOR-RUNBOOK.md, at 21:00 Pacific Sunday–Thursday. connector-delivery.js derives that repo root, imports runNightly from nightly.js, and launches the current main.js/story.js. story.js calls fetchEventsForDate -> prepareEvents -> consolidateEvents. No rebuild or alternate checkout is involved. The advisory recovery planner is not automatic gap repair and never starts an actor.

Final-review validation: 34 suites / 518 tests passed in 33.662s after the handle-identity fix and added cache/collaboration/recurrence tests. Corrected preview remains seven events, eight retained source rows, one page.

## User-confirmed October 16 edition revision

Jadon subsequently confirmed Aviation Club's October 16 meeting is at Lunch and requested STEM-PAC first for this edition only. The exact-event Aviation review now records that confirmation instead of unspecified time. A full-row October 16 STEM-PAC review supplies a presentation order only within its existing time band. Other dates/events do not inherit either exception. Revised preview: hermes-oct16-confirmed-preview, seven events, eight source rows, one page, zero measured overflow, safe area y=250..1670. Focused edition/story suite: 85 tests passed. All 111 durable state files still match baseline. No paid refresh or email.
