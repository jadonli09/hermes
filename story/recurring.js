// Weekly recurring meetings, kept out of the scrape entirely.
//
// A club that meets every Tuesday does not post about it every Tuesday, so
// recurring meetings live in recurring.json - edited from the dashboard's
// settings tab, never written by a scrape run. This module owns the file
// format; the web settings layer and the story generator both go through it.
import fs from 'fs';
import path from 'path';

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const DAY_NAMES = {
  Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday',
  Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday'
};

const MAX_LENGTH = { club: 60, time: 30, location: 60 };

const recurringPath = (dir) => path.join(dir, 'recurring.json');

/**
 * Meetings that recur on the given date's weekday.
 *
 * The date is parsed as UTC and the weekday read back in UTC, so the answer
 * does not shift by a day depending on the machine's timezone.
 *
 * @param {Array<Object>} meetings
 * @param {string} isoDate - YYYY-MM-DD
 * @returns {Array<Object>}
 */
export function meetingsOnDate(meetings, isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const weekday = DAYS[(new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7];
  return meetings.filter(meeting => meeting.days.includes(weekday));
}

/**
 * "Every Tuesday & Thursday" - the standing-schedule line shown when a
 * recurring meeting renders as a full event row.
 * @param {Array<string>} days - canonical Mon..Sun tokens
 * @returns {string}
 */
export function describeDays(days) {
  const names = days.map(day => DAY_NAMES[day]);
  const last = names.pop();
  return names.length === 0
    ? `Every ${last}`
    : `Every ${names.join(', ')} & ${last}`;
}

/**
 * Converts meetings into event rows for a day whose only schedule is the
 * standing one - the card would otherwise be empty, so space is free.
 * @param {Array<Object>} meetings
 * @returns {Array<Object>}
 */
export function asEvents(meetings) {
  return meetings.map(meeting => ({
    club_name: meeting.club,
    event_time: meeting.time,
    location: meeting.location,
    description: describeDays(meeting.days),
    recurring: true
  }));
}

/**
 * Validates and normalises {meetings: [...]}. Strings are trimmed, day tokens
 * are canonicalised and put in week order. Throws with a message naming the
 * problem; returns the cleaned structure.
 */
export function validateRecurring(recurring) {
  if (!recurring || !Array.isArray(recurring.meetings)) {
    throw new Error('recurring must have a "meetings" array');
  }

  const seen = new Set();
  const meetings = recurring.meetings.map((meeting, index) => {
    const clean = {};

    for (const field of ['club', 'time', 'location']) {
      const value = typeof meeting[field] === 'string' ? meeting[field].trim() : '';
      if (!value) throw new Error(`Meeting ${index + 1} is missing a ${field}`);
      if (value.length > MAX_LENGTH[field]) {
        throw new Error(`Meeting ${index + 1}: ${field} must be at most ${MAX_LENGTH[field]} characters`);
      }
      clean[field] = value;
    }

    if (!Array.isArray(meeting.days) || meeting.days.length === 0) {
      throw new Error(`"${clean.club}" needs at least one day`);
    }

    const days = meeting.days.map(raw => {
      const day = DAYS.find(d => d.toLowerCase() === String(raw).toLowerCase());
      if (!day) throw new Error(`"${clean.club}" has an invalid day "${raw}" (use ${DAYS.join(', ')})`);
      return day;
    });

    // One club, one entry per day: two entries claiming the same club on the
    // same day would render the strip twice and read as a data mistake.
    for (const day of days) {
      const key = `${clean.club.toLowerCase()}|${day}`;
      if (seen.has(key)) throw new Error(`"${clean.club}" is listed twice for ${day}`);
      seen.add(key);
    }

    clean.days = DAYS.filter(d => days.includes(d));
    return { club: clean.club, days: clean.days, time: clean.time, location: clean.location };
  });

  return { meetings };
}

/**
 * Reads recurring.json from the project directory. A missing file means no
 * recurring meetings yet; a malformed one throws rather than silently posting
 * a story with the standing schedule missing.
 * @param {string} projectDir
 * @returns {Array<Object>}
 */
export function loadRecurring(projectDir) {
  const file = recurringPath(projectDir);
  if (!fs.existsSync(file)) return [];
  return validateRecurring(JSON.parse(fs.readFileSync(file, 'utf-8'))).meetings;
}
