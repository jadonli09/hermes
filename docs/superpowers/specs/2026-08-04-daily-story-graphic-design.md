# Daily Story Graphic — Design

**Date:** 2026-08-04
**Status:** Approved, not yet implemented

## Purpose

Generate a 1080×1920 Instagram Story graphic listing the club events happening on a
given day, so `@msjclubs` can post a daily "what's on today" story.

Out of scope for this spec: publishing to Instagram. Graphics land in Google Drive
and are posted by hand from the phone. Automated publishing is a separate piece of
work with its own prerequisites (Business account, Meta app review).

## Command

```
npm run story                     # today
npm run story -- --date=2026-02-10
npm run story -- --out=./out      # write locally instead of uploading
```

Exit non-zero if the sheet cannot be read or rendering fails. A day with no events
is not a failure — it exits 0 and generates nothing (see Empty days).

## Data source: the sheet, never the scrape

The story reads the spreadsheet and filters on `event_date`. It must **not** be
built from a scrape run's results.

A club posts about a Feb 20 event on Feb 10. On Feb 20 the daily scrape finds
nothing new, but the event is happening. Building from scrape output would show
"events discovered today" instead of "events happening today" — empty on quiet
days, wrong on most others.

This makes the generator independent of scraping. It can be re-run for any past or
future date without re-scraping, which matters because design iteration must not
cost Apify calls.

Multi-day events need no special handling: the extractor already emits one row per
day, so a week-long event appears on each of its days.

### Filters

Included: rows whose `event_date` matches the target date.
Excluded: `event_type == "Announcement"`, and rows with `confidence < 0.3` —
matching what `CalendarSync.gs` already excludes, so the story and the calendar
never disagree.

## Pagination

Every event appears. Events are packed to a maximum per page, and the overflow
becomes additional story images posted in sequence.

- Max **7** events per page.
- Pages are balanced, not greedily filled: 8 events split 4+4, never 7+1. A story
  sequence ending on a near-empty page reads as a mistake.
- Pages are numbered `1 / N` in the footer; a single-page day still shows `1 / 1`.
- Time groups may split across pages. A group continued from the previous page
  repeats its header.

## Layout

Portrait 1080×1920. Instagram overlays its own UI on roughly the top and bottom
250px, so all content sits within y=250..1670.

```
┌─────────────────────────────┐
│        (IG UI zone)         │
│  ┌───────────────────────┐  │
│  │ Tuesday        MSJHS  │  │
│  │ Feb 10      5 EVENTS  │  │
│  │ CLUB SCHEDULE         │  │
│  │ ━━━━━━━━━━━━━━━━━━━━━ │  │
│  │ LUNCH ─────────────── │  │
│  │ (o) @club       [BTQ] │  │
│  │     description       │  │
│  │ (o) @club       [E2B] │  │
│  │ AFTER SCHOOL ──────── │  │
│  │ (o) @club       [B37] │  │
│  │ ━━━━━━━━━━━━━━━━━━━━━ │  │
│  │ @MSJCLUBS       1 / 2 │  │
│  └───────────────────────┘  │
│        (IG UI zone)         │
└─────────────────────────────┘
```

Events are grouped by `event_time`, ordered Before School → Lunch → After School →
specific clock times → untimed. The grouping encodes the real order of the school
day rather than decorating the list.

### Scale

Fewer events get larger type. One root scale factor multiplies every dimension;
no per-breakpoint hand-tuning.

Scale is chosen from the count on *that page*, so a 4+4 split renders both pages
at the same size.

| Events on page | Scale |
|---|---|
| ≤2 | 1.30 |
| 3–4 | 1.13 |
| 5–6 | 1.00 |
| 7 | 0.87 |

Blank space below a short list is acceptable and expected.

### Density

How much of each event is shown also follows the page's event count. A page with
one event has most of the card free, so truncating anything there loses
information for nothing.

| Events on page | Description | Location |
|---|---|---|
| ≤2 | 5 lines | Full text, stacked under the description |
| 3–4 | 3 lines | Truncated to 24 chars, chip beside the text |
| 5–7 | 2 lines | Truncated to 18 chars, chip beside the text |

On quiet pages the location moves *below* the description rather than beside it.
The spare space on such a page is vertical, not horizontal — a wide side chip
would only starve the description column, which is what made the club name and
long words overflow their box.

The character budget is divided by the page scale, so the chip holds a roughly
constant pixel width instead of growing with the type.

### Design tokens

Taken from the MSJ ASB site so the story matches the school's existing identity.

| Token | Value | Use |
|---|---|---|
| sage-600 | `#57694f` | Page background, room chips, group labels |
| bone | `#f6f5f0` | Card surface |
| ink | `#191d24` | Headings, club names |
| ink-muted | `#5c6570` | Descriptions, footer |
| sage-100 | `#e2e5dd` | Row dividers |
| sage-200 | `#cdd4c6` | Group rules, avatar ring |
| sage-400 | `#8c9f88` | Monogram fallback background |

Type: **General Sans** (display), **Satoshi** (body), **JetBrains Mono** (labels,
room codes). Self-hosted `.woff2`, copied into `assets/fonts/`.

Room codes are set in mono because `B17` / `E2B` / `A-Wing` are the school's own
vocabulary and read as codes, not prose.

## Club avatars

Each row shows the club's Instagram profile picture as a circle.

- Cached at `assets/avatars/<handle>.jpg`. Instagram CDN URLs are signed and
  expire, so images are downloaded, never hotlinked.
- Fetched via the Apify profile scraper (`apify/instagram-profile-scraper`),
  the same actor `verify-handles.js` uses. ~$0.21 for all 79 clubs.
- Refreshed by an explicit `npm run avatars`, not on the daily path. Profile
  pictures change rarely, and the daily story must cost nothing extra.
- **Fallback:** clubs with no picture render a monogram — the first letter after
  the `msj` prefix — in a sage circle. This is a normal path, not an edge case:
  1 of 5 clubs sampled had no profile picture.

Using avatars instead of emoji also removes a portability problem: emoji require a
color font that Linux CI runners lack, and would have rendered as blank boxes.

## Rendering

HTML + CSS screenshotted by Playwright at 1080×1920, deviceScaleFactor 1.

Playwright and Chromium are already dependencies. The alternatives (`node-canvas`,
SVG + `sharp`) add native dependencies and manual layout math for less capability.

The browser was removed from the *scraping* path because Instagram blocks
datacenter IPs; that does not apply to rendering a local file, so this does not
reintroduce the constraint. CI needs `npx playwright install chromium`.

**Fonts must be loaded via `page.goto('file://…')`, not `setContent`.** With
`setContent` the page origin is `about:blank`, `file://` font requests are blocked,
and the fonts silently fall back to system sans with no error.

## Output

Uploaded to a Google Drive folder, so the graphics are reviewable from a phone
alongside the sheet and calendar.

- Filename: `story-YYYY-MM-DD-p1.png`, `-p2.png`, …
- Re-running for the same date replaces that date's files rather than
  accumulating duplicates.
- `--out=<dir>` writes locally instead, for design iteration.

**The service account currently holds only the `spreadsheets` scope**
(`sheets-writer.js:17`). Drive upload additionally requires
`https://www.googleapis.com/auth/drive.file`.

**Gotcha:** a service account cannot write into a user's My Drive unaided. The
target folder must be shared with `club-scraper-bot@instagram-club-scraper.iam.gserviceaccount.com`
as Editor — the same step already done for the spreadsheet. Files will be owned by
the service account but visible in the shared folder.

## Empty days

A date with no qualifying events generates no image and exits 0, logging that it
found nothing. Weekends, holidays, and summer are normal. Posting a story that says
"no events today" would be worse than posting nothing.

## Modules

| File | Responsibility |
|---|---|
| `story/event-source.js` | Read sheet, filter to date, sort, group by time |
| `story/paginate.js` | Split events into pages, compute scale factor |
| `story/template.js` | Build HTML for one page |
| `story/render.js` | Playwright HTML → PNG |
| `story/avatars.js` | Avatar cache lookup, monogram fallback, refresh |
| `story/drive.js` | Upload / replace in Drive |
| `story.js` | CLI entry: parse args, orchestrate |

Each is independently testable. Only `render.js` needs a browser and only
`drive.js` needs network, so grouping, pagination, and template logic can be
tested with plain fixtures.

## Testing

Unit, no network:
- Date filtering, including the `MM/DD/YYYY` vs `YYYY-MM-DD` mismatch between the
  sheet and the extractor
- Announcement and low-confidence exclusion
- Time-group ordering
- Pagination boundaries: exactly 6, exactly 7, 1 event, 13 events
- Scale factor per bucket
- Monogram derivation, including handles with `.` and `_` separators
- HTML escaping — club descriptions come from Claude reading user-authored
  captions and can contain `<`, `&`, quotes

Render checks (browser, no network):
- Output is exactly 1080×1920
- All three fonts report `loaded`, guarding the `setContent` regression
- Content stays within the y=250..1670 safe zone

## Risks

| Risk | Mitigation |
|---|---|
| Sheet has a wrong date from a bad extraction; story shows a wrong event | Same data already reaches the calendar. A review gate exists before posting. Not solved here. |
| A long description blows out a row | Clamp to 2 lines with ellipsis |
| Drive scope/permission not configured | Fail with an explicit message naming the folder and service account, not a raw 403 |
| Avatar cache stale after a club rebrands | `npm run avatars` refresh; cosmetic until run |

## Decisions and their reasons

| Decision | Why |
|---|---|
| Separate command, not part of `npm start` | Re-rendering to tweak a design must not cost an Apify call |
| Read the sheet, not scrape results | Events happen on days when nothing new is posted |
| Paginate rather than truncate | No event should be silently dropped |
| Avatars over emoji | Recognizable club branding; also fixes CI emoji rendering |
| Blank space over shrinking to fill | Legibility matters more than density on a phone |
| Drive over a local folder | Approval happens on a phone |
| No "no events today" image | Silence is better than noise on weekends and holidays |
