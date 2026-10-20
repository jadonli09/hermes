# Current delivery route: Gmail connector

Use [CONNECTOR-RUNBOOK.md](CONNECTOR-RUNBOOK.md) for activation and recurring execution.
The parent agent owns the single schedule. Local Mail setup is stopped; the Mail
adapter below is retained but unused in connector mode. Connector configuration is
enabled; parent schedule creation is separate. No immediate run was started.

# Nightly Hermes (parent-scheduled connector delivery)

Schedule: Sunday–Thursday 21:00 America/Los_Angeles. Refresh once, then generate
Monday–Friday's event-date image from the entire Google Sheet and recurring.json.
Friday/Saturday nights do nothing. Delivery is one email with every generated PNG attached,
from and to ai.jadonli09@gmail.com. Messages delivery has been removed.

## Safe entry point

`npm run nightly` is read-only planning (outside the 21:00–06:00 window it reports
outside-window). `npm run nightly -- --execute` refuses to run without an explicit
`.hermes/nightly-config.json` containing `enabled: true`. The checked-in example
has both execution and delivery disabled, with the authorized sender and recipient. No launch agent was
installed. Do not enable it until a bounded paid refresh, the recipient, Mail
permission/account/test, Mac availability, and schedule activation have been approved.

The example plist belongs in the logged-in user's LaunchAgents only after that
approval. Create its log directory first. launchd's calendar follows the Mac's
system timezone: the supplied TZ controls the child, not the calendar trigger.
Keep the Mac timezone Pacific or adapt the trigger when traveling. The wrapper
always gates against Pacific time and refuses stale deliveries after 06:00.
The Mac needs network, an awake logged-in GUI session and a configured, enabled Apple Mail account for the exact sender.

## Coverage and costs

Every night re-scans an **overlapping window**: at least the last 4 Pacific
calendar days, with a per-club cap of 2 posts per day in the window (minimum 8).
Posts already in the Sheet are skipped before extraction, so the overlap costs
Apify rows but no Claude calls. A post missed once (blocked profile, late
visibility, several posts in one day) gets about four more chances.

A run is **source-healthy** when Instagram blocked at most 25% of the requested
accounts. Healthy nights see 0-4 of 93 blocked; the Oct 19, 2026 outage blocked
90. Only a source-healthy, fully processed run is recorded in
`.hermes/pipeline-activity.json` (version 2, `sourceHealthy: true`). Older
version-1 records and the legacy refresh checkpoint are ignored. After blocked
or missed nights the window widens back to the last healthy run, never more
than 11 days (cap 22). No history or a changed account list uses 11 days.

The delivery email warns only on a blocked night, with the blocked count in the
subject. Ambiguous-empty, capped and missing-handle accounts are normal and stay
in the coverage ledger without a warning.

**Apify cost:** about $0.0027 per returned row, and every requested account
returns at least one row, so 93 accounts cost at least $0.25 per run. A 4-day
window adds roughly 20 post rows (about $0.30 per night).

One logical job can start at most one Apify actor, capped at $2 (or a lower positive
configured value). There are no paid POST retries or sync-to-async duplicate starts.
The saved run ID is polled with bounded GET retries, and its dataset is paginated
and cached locally. Unknown starts and unresolved older actor jobs block new starts.
Budget-limit signals and extraction/Sheet failures block publication. In best-effort
mode, malformed rows and account errors become explicit coverage gaps while valid
posts continue; strict mode blocks these gaps. Multiple posts per Pacific day are
sizing advisories rather than retrieval failures; saturation remains a gap. Empty account results may still mean either
no posts or an upstream omission; Apify cannot prove completeness for those.
Apify's platform enforces its cost cap; local code does not meter invoices. Existing
manual entry points honor their configured per-run cap rather than the nightly $2
ceiling. Anthropic spend is separate; cached successful extraction (including valid
no-event outcomes) reduces it but is not a dollar cap.

Duplicate raw rows are removed per account/canonical post URL. Existing sheet URLs
skip extraction to preserve human corrections. Incoming event rows deduplicate by
post URL + event date + club, retaining multi-day events/collaboration identities.
Cached extraction lets a failed Sheets write retry without another Claude call.
A signed image-URL query change alone does not invalidate the cache; captions,
image paths, account/date and model configuration do. Revisions to the extraction
prompt/schema should bump the cache version in extraction-cache.js.

## Recovery

State lives in ignored `.hermes/`, written atomically with private file permissions.
Back up it along with the repo configuration; do not routinely delete it.

- `pipeline.lock` and `nightly/nightly.lock` exclude concurrent work. A hard kill
  may leave them: check no child process or paid request is active before removal.
- `apify/*-outstanding.json` points to an unresolved paid intent. Recover its exact
  run ID via Apify Console; populate the corresponding checkpoint's runId,
  datasetId and status only after verifying its saved actor/input/start time.
  Do not delete the marker to blindly rerun. Failed terminal runs require review.
- A cached completed dataset costs no new actor run to replay. Scheduled job
  inputs stay immutable; changing them requires explicit recovery, not a retry.
- `sheets-pending.json` means an append response was uncertain. Reconcile its rows
  with the sheet before clearing it. Append and underlying HTTP retries are
  disabled, preventing duplicate event rows from blind retries. Other writers
  outside Hermes are not covered by its process lock.
- Each nightly job saves refresh completion, image manifests/hashes and email
  submission state. A rerun skips completed stages. Fresh per-attempt output
  directories prevent stale PNGs from leaking into delivery.
- Empty output is successful silence. All nonempty pages attach in numeric order to one email.
- An email marked `sending` after interruption is ambiguous: inspect the intended
  Mail Outbox/Sent state before changing its state. Never automatically resend it. A
  successful AppleScript return confirms submission only, not inbox delivery.
- Replaying an old prepared job after 06:00 is intentionally blocked.

The adapter never reads message content or credentials. It verifies exactly one enabled
Mail account containing the configured sender address and an enabled outgoing server.
Changing sender/destination is blocked. Prior Messages page state requires manual review.
Direct AppleScript requires Automation consent for the eventual launcher; interactive Mail
permission was granted, but the required AI account is absent. No schedule is installed or active.

A one-time test using the connected Gmail account succeeded on October 13 with the
October 14 PNG (Gmail returned SENT and INBOX labels). This does not validate local
Apple Mail delivery: connector credentials are not accessible to this launchd job.
Local Mail setup was stopped because the AI account is absent; connector delivery
replaces this route. No account setup is planned. Existing Messages permission is retained.
Do not enable scheduling until the local sender/test and activation are approved.

## Official API references checked 2026-10-13

- https://apify.com/apify/instagram-post-scraper/input-schema — exact ISO or date
  cutoff (UTC), per-profile resultsLimit and skipPinnedPosts are supported. No
  documented known-post exclusion list or profile cursor exists in this schema.
- https://docs.apify.com/api/v2/act-runs-post — asynchronous start returns run and
  defaultDatasetId; maxTotalChargeUsd caps a run, maxItems is pricing-model-specific.
- https://docs.apify.com/api/v2/dataset-items-get — offset/limit paginate the saved
  dataset, not Instagram. Re-reading it does not start another scraper.

Detailed/basic actor data packages are documented, but this change retains the
existing data package until fixture/live verification establishes that the cheaper
package supplies all carousel images needed for extraction.

## Read-only gap recovery planning

`node automation/recovery-plan.js .hermes/nightly/account-coverage.json` prints a
proposal; it cannot start actors or clear state. Additional recovery is limited to
five accounts, with seven-day spacing for ambiguous-empty and three-day spacing
for blocked/absent accounts, measured from the latest regular or recovery attempt.
Missing handles and cap saturation require review. Original gap dates survive.
Inspect saved datasets/extractions first and pass cached account evidence to the
planner API when available. Any later paid recovery must share, not add to, the
existing $2 slot cap and respect outstanding actor intents. Normal scheduled
scanning remains unchanged; this is not an activated retry scheduler.

## Story reconciliation

Stories reconcile conservative same-club/date/room event-title matches only when
all explicit times and event types are compatible. Ambiguous groups stay separate.
The Sheet is unchanged; local output includes a `story-DATE-events.json` provenance
sidecar. Blank time displays as Time not specified; All day must be explicit.
New extractions no longer default to lunch. `story/reviewed-events.json` contains
source-reviewed historical corrections guarded by exact original row fields.
Manual changes to those fields disable the correction. Extraction cache identity
is version 2; existing Sheet URL dedup continues to protect previously saved rows.
The older cache files and historical images are retained untouched.
