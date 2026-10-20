// Reads the day's events from the spreadsheet.
//
// The sheet is the source, never a scrape run's results: a club posts about a
// Feb 20 event on Feb 10, so on Feb 20 the scrape finds nothing new while the
// event is very much happening.
import { authenticateSheets, normalizeDate } from '../sheets-writer.js';
import { retryWithBackoff } from '../utils/retry.js';
import { prepareEvents } from './prepare-events.js';

// A=club_name B=event_date C=event_time D=event_type E=location
// F=post_url G=posted_date H=confidence I=description J=last_updated
const COL = {
  club_name: 0, event_date: 1, event_time: 2, event_type: 3, location: 4,
  post_url: 5, posted_date: 6, confidence: 7, description: 8
};

// Kept in step with CalendarSync.gs so the story and the calendar never disagree
// about what counts as an event. "Recap" is set from the dashboard's Review tab
// for posts about something that already happened.
const EXCLUDED_TYPES = ['announcement', 'recap'];
const MIN_CONFIDENCE = 0.3;

/**
 * Whether a row belongs on the story.
 * @param {Object} event
 * @returns {boolean}
 */
export function isPublishable(event) {
  if (EXCLUDED_TYPES.includes(String(event.event_type || '').trim().toLowerCase())) {
    return false;
  }
  // A blank confidence predates the confidence column; treat it as passing
  // rather than silently dropping historical rows.
  const raw = String(event.confidence ?? '').trim();
  if (raw === '') return true;

  const confidence = parseFloat(raw);
  return isNaN(confidence) ? true : confidence >= MIN_CONFIDENCE;
}

/**
 * Reads every row of the sheet into event objects.
 * @param {Object} sheets - Authenticated Sheets client
 * @param {string} spreadsheetId
 * @returns {Promise<Array<Object>>}
 */
export async function readAllEvents(sheets, spreadsheetId) {
  const spreadsheet = await retryWithBackoff(() =>
    sheets.spreadsheets.get({ spreadsheetId })
  );

  if (!spreadsheet.data.sheets?.length) {
    throw new Error('Spreadsheet has no sheets');
  }
  const sheetName = spreadsheet.data.sheets[0].properties.title;

  const response = await retryWithBackoff(() =>
    sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!A:J` })
  );

  const rows = response.data.values || [];
  if (rows.length <= 1) return [];

  const cell = (row, i) => String(row[i] ?? '').trim();

  // Row 0 is the header
  return rows.slice(1).map(row => ({
    club_name: cell(row, COL.club_name),
    event_date: cell(row, COL.event_date),
    event_time: cell(row, COL.event_time),
    event_type: cell(row, COL.event_type),
    location: cell(row, COL.location),
    post_url: cell(row, COL.post_url),
    confidence: cell(row, COL.confidence),
    description: cell(row, COL.description)
  }));
}

/**
 * Filters events to a single day.
 *
 * The sheet stores dates as MM/DD/YYYY while callers pass YYYY-MM-DD, so both
 * sides are normalised before comparison.
 *
 * @param {Array<Object>} events
 * @param {string} isoDate - YYYY-MM-DD
 * @returns {Array<Object>}
 */
export function eventsOnDate(events, isoDate) {
  const target = normalizeDate(isoDate);
  return events.filter(e => normalizeDate(e.event_date) === target && isPublishable(e));
}

/**
 * Convenience wrapper: authenticate, read, filter to one date.
 * @returns {Promise<Array<Object>>}
 */
export async function fetchEventsForDate(credentialsPath, spreadsheetId, isoDate) {
  const sheets = await authenticateSheets(credentialsPath);
  const all = await readAllEvents(sheets, spreadsheetId);
  return prepareEvents(eventsOnDate(all, isoDate));
}
