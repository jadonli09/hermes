# Hermes connector run protocol

One parent-owned schedule: Sunday–Thursday at 21:00 America/Los_Angeles.
Resume this local Mac task. Do not create a LaunchAgent, second schedule, Mail
account, credentials, or a second sender. Mac/executor must be awake and online.
Missing connectivity/tools means report failure, not a guarantee of catch-up.
The wrapper accepts catch-up only until 06:00 Pacific the following morning.

## Activation (parent only after validation)

Copy automation/nightly-config.example.json to .hermes/nightly-config.json;
set enabled=true, deliveryMode="connector", deliveryEnabled=false, coverageMode="best-effort", budgetUsd=2,
recipient=fromAddress="ai.jadonli09@gmail.com". Keep file mode 0600.
Live configuration was enabled on October 13, 2026 at the parent's explicit request;
no run was started. Schedule creation belongs to the parent. The legacy nightly CLI
refuses execution in connector mode. No scheduled shell process should run it.

## Self-contained instructions for each scheduled agent turn

Work in /Users/jadonli/Downloads/Hermes with /usr/local/bin/node. First discover
Gmail get_profile, send_email, read_email, read_attachment, and search_emails tools.
Call get_profile on link_6ac224b8c2208191b3e218955d418956 and require returned email
ai.jadonli09@gmail.com. If tools/access are absent, reconnection is requested, or
identity differs, STOP before paid work and report the problem. Do not retrieve
credentials or use another account. Record UTC time of that successful read.

Run (substitute the real read completion timestamp):

    /usr/local/bin/node automation/connector-delivery.js prepare --profile-email ai.jadonli09@gmail.com --link-id link_6ac224b8c2208191b3e218955d418956 --checked-at <UTC-ISO>

The CLI requires preflight evidence less than five minutes old before refresh.
This is agent-supplied evidence of the tool read, not independent connector auth.
Never fabricate it. prepare uses existing healthy refresh/render checkpoints,
$2 maximum Apify actor budget, separate Claude spend, cache/deduplication, and
inactivity catch-up rules. No Mail or Gmail send occurs in the command.

- fallback-existing: stop; that night already has an approved fallback claim/receipt; never send again.
- outside-window: stop and report missed window if this was a scheduled run.
- empty: report no images; do not send an empty email.
- sent: inspect status for the slot; verify/reconcile its receipt if needed; never resend.
- awaiting-delivery: claim once using manifest.jobId:

    /usr/local/bin/node automation/connector-delivery.js claim --job <YYYY-MM-DD>

The atomic claim returns claimToken and a manifest: targetDate, unique subject,
exact sender/recipient/link, ordered file paths, MIME types, byte sizes, SHA-256
of raw PNG bytes, and manifestHash. Preserve these. Claim saves sending BEFORE
calling Gmail. A competing/repeated claim fails. Never delete a claim to retry.
Check current Pacific slot/cutoff again immediately before sending.

Read every manifest file as bytes inside the tool orchestration, verify size and
raw-byte SHA-256 against the manifest, and base64url-encode without logging the
payload or printing it to conversation. Ensure tool output isn't truncated.
Send exactly one Gmail multipart/mixed message using the manifest's linkId,
from, to, subject. Include manifest.requiredBodyText verbatim when nonempty and
say how many clubs Instagram blocked (coverage.blocked of coverage.requested) without claiming specific events are missing. requiredBodyText is empty on healthy nights; do not add a coverage warning then. Text body identifies
targetDate, with all image/png attachments
in manifest order and exact filenames. Do not add other recipients or files.
Do not send if any manifest check fails. Do not call the Apple Mail adapter.

On a successful Gmail result containing message ID, IMMEDIATELY persist it:

    /usr/local/bin/node automation/connector-delivery.js acknowledge --job <JOB> --claim <TOKEN> --message-id <GMAIL-ID>

Then read that exact Gmail message and its attachments, using read_attachment
when the body has an attachment ID. Validate the received body contains manifest.requiredBodyText when required.
Validate From/To, exact subject (including
job and target date), SENT and INBOX labels, attachment count/order, filename,
image/png MIME type, byte size, and SHA-256 of downloaded raw bytes. Construct
private evidence JSON (0600) without attachment data:

    {"messageId":"...","from":"ai.jadonli09@gmail.com","to":"ai.jadonli09@gmail.com","subject":"...","labels":["SENT","INBOX"],"bodyText":"<actual decoded received body>","attachments":[{"filename":"...","mimeType":"image/png","size":134073,"sha256":"..."}]}

Pass independently observed metadata/hashes, never simply copy the expected
manifest fields without checking the received message and bytes.

    /usr/local/bin/node automation/connector-delivery.js verify --job <JOB> --claim <TOKEN> --evidence <ABSOLUTE-JSON-PATH>

Report target date, page count, Gmail message ID and verified/submitted state.
If Inbox is delayed or verification fails, keep the receipt; do not resend.

## Ambiguous send / interruption / recovery

    /usr/local/bin/node automation/connector-delivery.js status --job <JOB>

A job with connector.status=sending already consumed its claim. Search only the
exact deterministic subject, sender and recipient for that job in Gmail. Read
candidate metadata/attachments and validate against the saved manifest hash and
fresh file manifest. If exactly one full match exists, acknowledge that message
ID with the saved token and verify normally. If absent, multiple, or uncertain,
STOP and report; absence in search is not proof nothing was sent. Do not resend,
clear state, start another actor, or substitute today's image for an old slot.
A job with an existing receipt uses that exact message ID, never another send.
Acknowledgement may happen after cutoff to record an already completed send.

State lives in .hermes/nightly/<night>/job.json. Keep it durable. Overlap/stale
locks fail closed; do not remove them automatically. Delivery failure doesn't
undo a successful refresh watermark. The next normal run uses existing coverage.

## Best-effort coverage policy (authorized October 14)

Pipeline completion and coverage completeness are separate. Valid posts continue
through cached extraction and Sheet writes even when other accounts have coverage
gaps. Failed extraction/Sheet writes, an uncertain paid request, exceeded budget,
invalid manifests, and unsafe delivery state still stop the run.

Coverage records classify ambiguous-empty, blocked, missing-handle, absent-input,
partial-pagination, unusable/provider-error, unknown diagnostics and cap saturation.
Daily-rate deviations are separate sizing advisories, not inferred missing posts. Clean observed results below the cap, with available
actor diagnostics and no known failures, may advance only their own boundary.
That is observed provider coverage, not independent proof of Instagram completeness.
No current provider field certifies a normal empty window: no_items with an empty
requestErrorMessages list remains ambiguous, never fabricated as confirmed-empty.
Owner and coauthor URLs are retained as related content, not proof of full input coverage.

State: .hermes/nightly/account-coverage.json retains each account's coveredFrom or
gapSince and latest evidence. Unknown/failed accounts never advance; a clean but
narrower window cannot clear an older gap. Scope changes preserve unchanged
accounts' gaps and archive removed-account history. This ledger does NOT determine
the ordinary actor's retrieval window.

Normal planning uses .hermes/pipeline-activity.json (version 2): the START of the
last full-account run that was source-healthy, meaning Instagram blocked at most 25%
of requested accounts. A blocked night is never recorded as activity, and
version-1 records are ignored. Every night re-scans at least the last 4 Pacific days
(cap 2 posts per day in the window, minimum 8). After blocked or missed nights the
window widens back to the last healthy run, never more than 11 days (cap 22). New
account scope or no trustworthy activity uses 11 days. Failed/interrupted refreshes
and subset runs cannot supply activity; a healthy completed refresh followed by a
rendering or delivery failure can.

Existing jobs retain saved plans and original paid actor inputs. No migration may
rewrite sent/verified records, paid intents, coverage history or delivery claims.
The separate recovery-plan.js remains advisory-only, cannot start actors and has
no extra budget. The $2 actor ceiling and separate Claude usage remain unchanged.

For NEW jobs, observedCoverageReport retains the actual current-window evidence.
coverageReport additionally qualifies unresolved historical gaps for publication.
A historical-gap means a clean latest window did not recover its older boundary;
it is not a newly blocked request. Historical gaps and ambiguous-empty accounts are
normal and do NOT warrant an email warning. Strict publication still blocks
unresolved coverage.

The email warns only on a blocked night. Then the manifest subject ends with
"— scrape blocked for N of M clubs" and manifest.requiredBodyText holds the exact
warning; include it verbatim. On healthy nights requiredBodyText is empty: add no
coverage warning to the subject or body. Never alter manifest.subject. Verify saves
actual received bodyText in evidence, alongside attachment verification. Report a
blocked night to the parent as a qualified delivery.

Strict mode remains available with coverageMode="strict" in the same config;
it blocks reports with any unresolved coverage uncertainty. Do not change an
in-progress job's mode or delete safeguards to retry. The October 13 failed job
and separately verified fallback remain unchanged and must not be replayed.

Research context: independent public checks found CE, AMWA and Philosophy profiles
accessible with older visible posts. Blocked requests therefore prove uncertainty,
not missing recent events. Cached coauthored posts include Civics and Neuroscience;
MUN's two independently observed recent owned posts are also present. A provider
reordered-grid/date-filter bug was reportedly fixed October 13; it is not established
as the cause for this build/run:
https://apify.com/apify/instagram-post-scraper/issues/not-retrieving-all-p-lI1kVEtkxTWygTQD6
