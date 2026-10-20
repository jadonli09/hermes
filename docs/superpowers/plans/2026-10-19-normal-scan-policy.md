# Normal scan activity / coverage separation — October 19, 2026

Implemented with explicit user authorization. No paid actor, production extraction, email, schedule change or credential change was performed.

## Coverage answer

All 45 unresolved handles were present in the saved actor input, out of 93 requested accounts. None is excluded by advisory recovery backoff. The same normal selection path requests all configured enabled accounts: RESUME=false, no category/test filter, high max-club ceiling. Data Science IS configured as msjdatascience; the source says not_found, not that configuration is missing.

38 profiles returned ambiguous no_items; four were blocked (msj.pickleball, msjrocketry, msjvams, msjwritersblock); two lacked input attribution (msjmocktrial, msjmedcorps); msjdatascience was not_found. All remain unresolved. No profile was declared inactive or retired.

Absent attribution means no returned row is assigned to that requested profile. It does not mean no relevant content was returned: Mock Trial's collaboration is attributed to Civics, and Medcorps' post to Neuroscience. Such content may be extracted under the attributed input account; it does not prove full traversal of the other profile.

If a valid new post is returned within the requested date window, best-effort continues processing it despite other source gaps. Previously stored URLs are deduplicated; introductory/non-event material may be filtered; extraction may identify no event or fail. The story reads stored events for its target date and excludes Announcement/Recap and confidence below 0.3. A new post is therefore not automatically a card. Source blocking, missing profiles, private/empty ambiguity, imperfect attribution, per-run post caps and provider ordering/reliability still prevent a guarantee. Successful email delivery verifies the artifact, not source completeness.

## Implemented policy

- New .hermes/pipeline-activity.json records the start of successful full-account processing independently of source coverage. Healthy full-scope manual processing counts too. Failed extraction/Sheet processing, incomplete selection and unfinished refreshes do not. If refresh completed but rendering or delivery later failed, that completed processing remains valid activity.
- New normal plans use this activity, not coverageFloor or an older failed job. Daily cap is one; normal Sunday uses the Thursday-night boundary through Sunday (Friday–Sunday activity), cap three. One-to-six-day inactivity uses actual gap. At least seven Pacific calendar days without successful processing triggers eleven-day catch-up. No trusted history or changed account scope bootstraps eleven days. No automatic weekly backfill.
- Existing in-progress jobs keep their saved plan and paid actor identity. No sent/verified job is rewritten.
- Old gapSince values remain separate. Clean narrow observations cannot clear them. New publication reports qualify historical-gap and preserve the exact incomplete-coverage warning even when the latest observed window is clean. observedCoverageReport stores current evidence independently.
- Account-scope changes preserve unchanged accounts' gap boundaries and archive removed accounts under previousScopes rather than deleting their history. A verified replacement/removal must still be an explicit administrative action.
- Extra recovery remains advisory-only and cannot launch actors. One existing $2 Apify ceiling; Claude usage separate; duplicate claim/send/ack/verify protections unchanged.

## Migration and verification

Migration used healthy saved job 2026-10-18, scheduled start 2026-10-19T04:00:00.000Z. Under the existing lock, only the new pipeline-activity.json file was written. All 126 pre-existing durable files remain byte-identical, including every image, gap ledger, actor checkpoint and sent/verified receipt.

Read-only next-night plan: night 2026-10-19, target 2026-10-20, since 2026-10-19T04:00:00Z, cap 1, catchUp false, budget $2, deliver false. This replaces the old October 3 / cap 17 plan without clearing any gap.

566 tests across 35 suites passed (51.125s). Coverage includes daily/Sunday/DST windows, seven-day trigger, eleven-day long-outage/bootstrap windows, failed/interrupted/subset runs, healthy historical migration, missing-handle gaps, account-scope archival, clean narrow historical warnings, and existing actor/delivery protections. git diff --check passed. Tests were run in an isolated checkout without production credentials.

## Files and rollback

Code: automation/pipeline-activity.js, automation/nightly.js, automation/coverage.js, main.js. Tests: __tests__/pipeline-activity.test.js and updated __tests__/nightly.test.js. Documentation: automation/README.md and automation/CONNECTOR-RUNBOOK.md.

Baseline: /Users/jadonli/Documents/Codex/2026-10-13/task/hermes-pipeline-policy-backup. Preserve later work before rollback. Restore only this change's original code/doc/test files and remove its new code/test files if rollback is authorized; do not overwrite historical .hermes state. The new pipeline activity record is not a coverage watermark. Any rollback involving it should preserve its evidence for subsequent migration.
