// Splitting a day's events across story images, and sizing the type to fit.

export const MAX_PER_PAGE = 7;

// Named periods come first in the order they occur during the school day.
// Anything with a clock time follows, then undated/untimed entries last.
const NAMED_ORDER = ['Before School', 'Lunch', 'After School'];

/**
 * Sort key for an event's time. Named periods occupy 0..2, clock times share
 * band 3 (ordered among themselves by minutes), and untimed events sort last.
 * @param {string|null} time
 * @returns {number}
 */
export function timeRank(time) {
  const t = String(time || '').trim();
  if (!t) return 9;

  const named = NAMED_ORDER.findIndex(n => n.toLowerCase() === t.toLowerCase());
  if (named !== -1) return named;

  const clock = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (clock) {
    let hour = parseInt(clock[1], 10) % 12;
    const min = parseInt(clock[2] || '0', 10);
    const meridiem = (clock[3] || '').toLowerCase();
    if (meridiem === 'pm') hour += 12;
    // Bare hours with no am/pm during a school day are far likelier to be
    // afternoon than pre-dawn
    else if (!meridiem && hour < 7) hour += 12;
    return 3 + (hour * 60 + min) / 1440;
  }

  // An unrecognised label ("During READ", "TBD") still belongs on the story,
  // just after everything we can order confidently
  return 8;
}

/**
 * Orders events for display. Stable within a time band, so clubs keep the order
 * the sheet gave them.
 */
export function sortEvents(events) {
  return [...events].sort((a, b) => timeRank(a.event_time) - timeRank(b.event_time));
}

/**
 * Splits events across pages, balancing sizes rather than filling greedily.
 *
 * 8 events become 4+4, never 7+1: a story sequence that ends on a nearly empty
 * card reads as a mistake rather than a design.
 *
 * @param {Array} events
 * @param {number} [maxPerPage]
 * @param {number} [reserveLast] - Event slots to keep free on the final page,
 *   so the recurring-meetings strip has room to render there
 * @returns {Array<Array>} one array of events per page
 */
export function paginate(events, maxPerPage = MAX_PER_PAGE, reserveLast = 0) {
  if (!events || events.length === 0) return [];

  // Counting the reserved slots as phantom events forces an extra page exactly
  // when the strip would not fit; the balanced split below then hands the
  // smaller share to the last page, which is where the strip lives.
  const pageCount = Math.ceil((events.length + reserveLast) / maxPerPage);
  const base = Math.floor(events.length / pageCount);
  const remainder = events.length % pageCount;

  const pages = [];
  let cursor = 0;
  for (let p = 0; p < pageCount; p++) {
    const size = base + (p < remainder ? 1 : 0);
    pages.push(events.slice(cursor, cursor + size));
    cursor += size;
  }
  return pages;
}

/**
 * Type scale for a page, chosen from that page's own event count so a balanced
 * split renders every page at the same size. Fewer events means larger type;
 * blank space below a short list is intended.
 */
export function scaleFor(count) {
  if (count <= 2) return 1.30;
  if (count <= 4) return 1.13;
  if (count <= 6) return 1.00;
  return 0.87;
}

/**
 * Groups a page's events into consecutive runs sharing a time label, preserving
 * order. A run continued from the previous page repeats its header, which is
 * what the caller wants for a split group.
 * @returns {Array<{time: string, events: Array}>}
 */
export function groupByTime(events) {
  const groups = [];
  for (const event of events) {
    const label = String(event.event_time || '').trim() || 'Time not specified';
    const last = groups[groups.length - 1];
    if (last && last.time === label) {
      last.events.push(event);
    } else {
      groups.push({ time: label, events: [event] });
    }
  }
  return groups;
}
