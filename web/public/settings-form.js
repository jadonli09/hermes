// The two judgements behind a settings save: which recurring rows are real,
// and whether anything is actually unsaved. app.js is DOM plumbing over these.
//
// Loaded both as an ES module in the browser and by Jest, so it imports
// nothing - same constraint as state.js and pricing.js.

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * Trims the text and puts the days in week order.
 *
 * Both the rows read out of the form and the ones handed back by the server go
 * through this, so the two are directly comparable. Without that, a
 * recurring.json edited by hand into ["Thu", "Tue"] would read as an unsaved
 * edit forever - the server returns the file as written, and the form always
 * collects Mon-first.
 *
 * @param {Array<Object>} rows
 * @returns {Array<Object>} rows in the shape recurring.json stores
 */
export function normalizeRecurringRows(rows) {
  return (rows ?? []).map(row => {
    const days = (row.days ?? []).map(day => String(day).toLowerCase());
    return {
      club: String(row.club ?? '').trim(),
      days: DAYS.filter(day => days.includes(day.toLowerCase())),
      time: String(row.time ?? '').trim(),
      location: String(row.location ?? '').trim()
    };
  });
}

/**
 * A row with nothing in it at all.
 *
 * "+ Add meeting" puts an empty row on the page on purpose - it is the only
 * way to start typing one - so an abandoned row is a normal state rather than
 * a mistake. Sending it would fail validation, and because the server writes
 * nothing unless everything passes, it would take every other edit on the page
 * down with it. A half-filled row is NOT blank: the user meant something by it
 * and deserves the error rather than silent deletion.
 */
export function isBlankRow(row) {
  return !row.club && !row.time && !row.location && row.days.length === 0;
}

/**
 * Deep equality over the settings patch, insensitive to key order, so a value
 * that has round-tripped through the server compares equal to the one the form
 * is holding. Used to tell an untouched form from an edited one.
 */
export function sameSettings(a, b) {
  if (a === b) return true;

  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b)
      && a.length === b.length
      && a.every((item, index) => sameSettings(item, b[index]));
  }

  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length
      && keys.every(key => Object.hasOwn(b, key) && sameSettings(a[key], b[key]));
  }

  return a === b;
}
