// Admin review: the rows Claude was unsure about, surfaced for a human to fix.
//
// A row needs review when the extraction confidence is low or a field the story
// needs (date, time, location) is missing. Edits write straight back to the
// sheet; a saved row is stamped confidence 1.0 because a human has now looked
// at it, which also lifts it past the story's publish filter.
import { normalizeDate } from '../sheets-writer.js';
import { retryWithBackoff } from '../utils/retry.js';

// Below this, an extraction is worth a second pair of eyes even when every
// field is filled in. Distinct from the story's 0.3 publish floor: 0.3-0.7
// still publishes, but it publishes unverified.
export const REVIEW_CONFIDENCE = 0.7;

// A=club_name B=event_date C=event_time D=event_type E=location
// F=post_url G=posted_date H=confidence I=description J=last_updated
const SHEET_COLUMN = { event_date: 'B', event_time: 'C', location: 'E', description: 'I' };
const TYPE_COLUMN = 'D';
const EDITABLE_FIELDS = {
  event_date:  { maxLength: 20 },
  event_time:  { maxLength: 40 },
  location:    { maxLength: 80 },
  description: { maxLength: 300 }
};

// Announcements and recaps never reach the story or the calendar, so a hole in
// one is not worth anyone's time. Kept in step with story/event-source.js and
// CalendarSync.gs.
const EXCLUDED_TYPES = ['announcement', 'recap'];

/**
 * Why a row needs attention. Empty array means it does not.
 * @param {Object} event
 * @returns {Array<string>}
 */
export function reviewIssues(event) {
  if (EXCLUDED_TYPES.includes(String(event.event_type || '').trim().toLowerCase())) {
    return [];
  }

  const issues = [];
  if (!String(event.event_date || '').trim()) issues.push('missing date');
  if (!String(event.event_time || '').trim()) issues.push('missing time');
  if (!String(event.location || '').trim()) issues.push('missing location');

  // A blank confidence predates the confidence column; only a recorded low
  // number flags the row.
  const confidence = parseFloat(String(event.confidence ?? '').trim());
  if (!isNaN(confidence) && confidence < REVIEW_CONFIDENCE) issues.push('low confidence');

  return issues;
}

async function firstSheetName(sheets, spreadsheetId) {
  const spreadsheet = await retryWithBackoff(() => sheets.spreadsheets.get({ spreadsheetId }));
  if (!spreadsheet.data.sheets?.length) throw new Error('Spreadsheet has no sheets');
  return spreadsheet.data.sheets[0].properties.title;
}

/**
 * Rows that need a human, with the sheet row index so an edit can target them.
 *
 * Past events are left alone - the story for that day has already gone out, so
 * filling them in fixes nothing. Undated rows always show, since "no date" is
 * exactly the hole being filled.
 *
 * @param {Object} sheets - Authenticated Sheets client
 * @param {string} spreadsheetId
 * @param {string} today - YYYY-MM-DD; rows before this date are skipped
 * @returns {Promise<Array<Object>>}
 */
export async function listReviewEvents(sheets, spreadsheetId, today) {
  const sheetName = await firstSheetName(sheets, spreadsheetId);
  const response = await retryWithBackoff(() =>
    sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!A:J` })
  );

  const rows = response.data.values || [];
  const cell = (row, i) => String(row?.[i] ?? '').trim();
  const cutoff = normalizeDate(today);
  const found = [];

  // Row 0 is the header; sheet rows are 1-indexed, so data starts at index 1 = row 2
  for (let i = 1; i < rows.length; i++) {
    const event = {
      rowIndex: i + 1,
      club_name: cell(rows[i], 0),
      event_date: cell(rows[i], 1),
      event_time: cell(rows[i], 2),
      event_type: cell(rows[i], 3),
      location: cell(rows[i], 4),
      post_url: cell(rows[i], 5),
      posted_date: cell(rows[i], 6),
      confidence: cell(rows[i], 7),
      description: cell(rows[i], 8)
    };

    // A row with no club and no post is a stray blank line, not an event
    if (!event.club_name && !event.post_url) continue;

    const date = normalizeDate(event.event_date);
    if (date && date < cutoff) continue;

    const issues = reviewIssues(event);
    if (issues.length > 0) found.push({ ...event, issues });
  }

  // Undated rows first - they are the most broken - then soonest date
  return found.sort((a, b) => {
    const da = normalizeDate(a.event_date) || '';
    const db = normalizeDate(b.event_date) || '';
    if (da !== db) return da < db ? -1 : 1;
    return a.club_name.localeCompare(b.club_name);
  });
}

// Matches sheets-writer: the sheet displays MM/DD/YYYY
function toSheetDate(value) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[2]}/${match[3]}/${match[1]}` : value;
}

function formatTimestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

/**
 * Validates a review edit without touching the sheet, so a bad request writes
 * nothing at all.
 * @param {*} rowIndex
 * @param {Object} fields
 * @returns {{rowIndex: number, fields: Object}} cleaned values
 */
export function validateRowIndex(rowIndex) {
  const row = Number(rowIndex);
  if (!Number.isInteger(row) || row < 2) {
    throw new Error('rowIndex must be a sheet row of 2 or higher');
  }
  return row;
}

export function validateReviewUpdate(rowIndex, fields) {
  const row = validateRowIndex(rowIndex);

  if (!fields || typeof fields !== 'object') throw new Error('fields must be an object');

  const clean = {};
  for (const [key, raw] of Object.entries(fields)) {
    const rule = EDITABLE_FIELDS[key];
    if (!rule) throw new Error(`${key} is not editable from the review panel`);

    const value = String(raw).trim();
    if (value === '') continue;   // an untouched input is not an edit
    if (value.length > rule.maxLength) {
      throw new Error(`${key} must be at most ${rule.maxLength} characters`);
    }
    if (key === 'event_date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new Error('event_date must be YYYY-MM-DD');
    }

    clean[key] = value;
  }

  if (Object.keys(clean).length === 0) throw new Error('Nothing to save');
  return { rowIndex: row, fields: clean };
}

/**
 * Writes a human's corrections to one sheet row.
 *
 * Only the edited cells are written, plus confidence (a person has verified the
 * row now) and the last-updated stamp - untouched columns keep whatever the
 * scrape put there.
 *
 * @param {Object} sheets - Authenticated Sheets client
 * @param {string} spreadsheetId
 * @param {*} rowIndex - 1-indexed sheet row
 * @param {Object} fields - subset of {event_date, event_time, location, description}
 * @returns {Promise<{rowIndex: number, updated: Array<string>}>}
 */
export async function applyReviewUpdate(sheets, spreadsheetId, rowIndex, fields) {
  const clean = validateReviewUpdate(rowIndex, fields);
  const sheetName = await firstSheetName(sheets, spreadsheetId);

  const data = Object.entries(clean.fields).map(([key, value]) => ({
    range: `${sheetName}!${SHEET_COLUMN[key]}${clean.rowIndex}`,
    values: [[key === 'event_date' ? toSheetDate(value) : value]]
  }));

  data.push({ range: `${sheetName}!H${clean.rowIndex}`, values: [['1']] });
  data.push({ range: `${sheetName}!J${clean.rowIndex}`, values: [[formatTimestamp()]] });

  await retryWithBackoff(() =>
    sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      resource: { valueInputOption: 'USER_ENTERED', data }
    })
  );

  return { rowIndex: clean.rowIndex, updated: Object.keys(clean.fields) };
}

/**
 * Marks one row as a recap: a post about something that already happened, not
 * an event to put on the story or the calendar.
 *
 * "Recap" is an excluded type everywhere (story, calendar, this review queue),
 * so the row keeps its history in the sheet but stops being treated as an
 * event. Confidence is stamped too - a human made this call.
 *
 * @param {Object} sheets - Authenticated Sheets client
 * @param {string} spreadsheetId
 * @param {*} rowIndex - 1-indexed sheet row
 * @returns {Promise<{rowIndex: number, event_type: string}>}
 */
export async function markAsRecap(sheets, spreadsheetId, rowIndex) {
  const row = validateRowIndex(rowIndex);
  const sheetName = await firstSheetName(sheets, spreadsheetId);

  await retryWithBackoff(() =>
    sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      resource: {
        valueInputOption: 'USER_ENTERED',
        data: [
          { range: `${sheetName}!${TYPE_COLUMN}${row}`, values: [['Recap']] },
          { range: `${sheetName}!H${row}`, values: [['1']] },
          { range: `${sheetName}!J${row}`, values: [[formatTimestamp()]] }
        ]
      }
    })
  );

  return { rowIndex: row, event_type: 'Recap' };
}
