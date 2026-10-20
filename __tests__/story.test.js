import { timeRank, sortEvents, paginate, scaleFor, groupByTime, MAX_PER_PAGE } from '../story/paginate.js';
import { isPublishable, eventsOnDate } from '../story/event-source.js';
import { monogram } from '../story/avatars.js';
import {
  escapeHtml, formatHeading, densityFor, buildPage, normalizeLocation, scaleToFit, SHEET_HEIGHT
} from '../story/template.js';
import { buildIntroPage } from '../story/intro.js';

const ev = (over = {}) => ({
  club_name: 'msjbio', event_date: '02/10/2026', event_time: 'Lunch',
  event_type: 'Club Meeting', location: 'B17', post_url: 'https://ig/p/A/',
  confidence: '0.9', description: 'Weekly meeting', ...over
});

describe('timeRank', () => {
  it('orders named periods by when they occur in the school day', () => {
    expect(timeRank('Before School')).toBeLessThan(timeRank('Lunch'));
    expect(timeRank('Lunch')).toBeLessThan(timeRank('After School'));
  });

  it('places clock times after named periods and orders them chronologically', () => {
    expect(timeRank('After School')).toBeLessThan(timeRank('3:30 PM'));
    expect(timeRank('3:30 PM')).toBeLessThan(timeRank('7:00 PM'));
  });

  it('sorts untimed events last so they do not interrupt the day', () => {
    expect(timeRank('')).toBeGreaterThan(timeRank('7:00 PM'));
    expect(timeRank(null)).toBeGreaterThan(timeRank('After School'));
  });

  it('keeps an unrecognised label on the story rather than dropping it', () => {
    const rank = timeRank('During READ');
    expect(rank).toBeGreaterThan(timeRank('7:00 PM'));
    expect(rank).toBeLessThan(timeRank(''));
  });

  it('reads a bare early hour as afternoon, which a school day makes far likelier', () => {
    expect(timeRank('3:00')).toBeGreaterThan(timeRank('11:00 AM'));
  });

  it('is case insensitive', () => {
    expect(timeRank('lunch')).toBe(timeRank('Lunch'));
  });
});

describe('sortEvents', () => {
  it('orders a mixed day correctly', () => {
    const sorted = sortEvents([
      ev({ club_name: 'c', event_time: '' }),
      ev({ club_name: 'a', event_time: 'After School' }),
      ev({ club_name: 'b', event_time: 'Lunch' })
    ]);
    expect(sorted.map(e => e.club_name)).toEqual(['b', 'a', 'c']);
  });

  it('does not mutate its input', () => {
    const input = [ev({ event_time: 'After School' }), ev({ event_time: 'Lunch' })];
    sortEvents(input);
    expect(input[0].event_time).toBe('After School');
  });
});

describe('paginate', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => ev({ club_name: `c${i}` }));

  it('keeps a full page on one page', () => {
    expect(paginate(many(MAX_PER_PAGE)).map(p => p.length)).toEqual([7]);
  });

  // The rule that matters: a trailing near-empty card reads as a mistake
  it('balances rather than filling greedily', () => {
    expect(paginate(many(8)).map(p => p.length)).toEqual([4, 4]);
    expect(paginate(many(9)).map(p => p.length)).toEqual([5, 4]);
    expect(paginate(many(15)).map(p => p.length)).toEqual([5, 5, 5]);
  });

  it('never leaves a page with a single event when it can be avoided', () => {
    for (let n = 2; n <= 40; n++) {
      const sizes = paginate(many(n)).map(p => p.length);
      if (n > 1) expect(Math.min(...sizes)).toBeGreaterThan(1);
    }
  });

  it('loses no events at any size', () => {
    for (let n = 1; n <= 40; n++) {
      expect(paginate(many(n)).flat()).toHaveLength(n);
    }
  });

  it('returns nothing for an empty day', () => {
    expect(paginate([])).toEqual([]);
  });
});

describe('scaleFor', () => {
  it('gives fewer events larger type', () => {
    expect(scaleFor(1)).toBeGreaterThan(scaleFor(4));
    expect(scaleFor(4)).toBeGreaterThan(scaleFor(6));
    expect(scaleFor(6)).toBeGreaterThan(scaleFor(7));
  });

  it('scales a balanced split identically on both pages', () => {
    const [a, b] = paginate(Array.from({ length: 8 }, () => ev()));
    expect(scaleFor(a.length)).toBe(scaleFor(b.length));
  });
});

describe('groupByTime', () => {
  it('groups consecutive events sharing a time', () => {
    const groups = groupByTime([
      ev({ event_time: 'Lunch' }), ev({ event_time: 'Lunch' }), ev({ event_time: 'After School' })
    ]);
    expect(groups.map(g => [g.time, g.events.length])).toEqual([['Lunch', 2], ['After School', 1]]);
  });

  it('labels untimed events rather than showing a blank header', () => {
    expect(groupByTime([ev({ event_time: '' })])[0].time).toBe('Time not specified');
  });
});

describe('isPublishable', () => {
  it('drops announcements, matching what the calendar already excludes', () => {
    expect(isPublishable(ev({ event_type: 'Announcement' }))).toBe(false);
    expect(isPublishable(ev({ event_type: 'announcement' }))).toBe(false);
  });

  it('drops recaps marked from the review tab', () => {
    expect(isPublishable(ev({ event_type: 'Recap' }))).toBe(false);
    expect(isPublishable(ev({ event_type: 'recap' }))).toBe(false);
  });

  it('drops low-confidence extractions', () => {
    expect(isPublishable(ev({ confidence: '0.2' }))).toBe(false);
    expect(isPublishable(ev({ confidence: '0.3' }))).toBe(true);
  });

  it('keeps rows with no confidence recorded rather than dropping history', () => {
    expect(isPublishable(ev({ confidence: '' }))).toBe(true);
    expect(isPublishable(ev({ confidence: 'n/a' }))).toBe(true);
  });
});

describe('eventsOnDate', () => {
  // The sheet stores MM/DD/YYYY; callers pass YYYY-MM-DD
  it('matches across the two date formats in play', () => {
    const found = eventsOnDate([ev({ event_date: '02/10/2026' })], '2026-02-10');
    expect(found).toHaveLength(1);
  });

  it('excludes other days', () => {
    expect(eventsOnDate([ev({ event_date: '02/11/2026' })], '2026-02-10')).toHaveLength(0);
  });

  it('applies the publishable filter while selecting the day', () => {
    expect(eventsOnDate([ev({ event_type: 'Announcement' })], '2026-02-10')).toHaveLength(0);
  });

  it('ignores rows with no date', () => {
    expect(eventsOnDate([ev({ event_date: '' })], '2026-02-10')).toHaveLength(0);
  });
});

describe('monogram', () => {
  it('skips the msj prefix so clubs do not all read as M', () => {
    expect(monogram('msjdatascience')).toBe('D');
    expect(monogram('msjbio')).toBe('B');
  });

  it('handles the dot and underscore separators used by some handles', () => {
    expect(monogram('msj.pickleball')).toBe('P');
    expect(monogram('msj_msa')).toBe('M');
  });

  it('falls back to the first character for a non-msj handle', () => {
    expect(monogram('phoenixmsj')).toBe('P');
  });

  it('does not throw on empty input', () => {
    expect(monogram('')).toBe('?');
  });
});

describe('escapeHtml', () => {
  // Descriptions come from Claude reading user-authored captions
  it('neutralises markup that would break the template', () => {
    expect(escapeHtml('<script>alert(1)</script>'))
      .toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes ampersands and quotes', () => {
    expect(escapeHtml('Tea & Crumpets "free"')).toBe('Tea &amp; Crumpets &quot;free&quot;');
  });
});

describe('formatHeading', () => {
  it('formats the story heading from an ISO date', () => {
    expect(formatHeading('2026-02-10')).toEqual({ weekday: 'Tuesday', monthDay: 'Feb 10' });
  });

  it('does not slip a day near month boundaries', () => {
    expect(formatHeading('2026-03-01').monthDay).toBe('Mar 1');
    expect(formatHeading('2026-12-31').monthDay).toBe('Dec 31');
  });
});

describe('densityFor', () => {
  it('shows the location in full when the page is nearly empty', () => {
    expect(densityFor(1).locationMax).toBeNull();
    expect(densityFor(2).locationMax).toBeNull();
  });

  it('starts truncating once events compete for space', () => {
    expect(densityFor(3).locationMax).toBe(24);
    expect(densityFor(7).locationMax).toBe(18);
  });

  // The bug this fixes: a single event was clamped to 2 lines with ~900px of
  // empty card below it, so a truncated description lost information for nothing
  it('gives more description lines to quieter pages', () => {
    expect(densityFor(1).descLines).toBeGreaterThan(densityFor(3).descLines);
    expect(densityFor(3).descLines).toBeGreaterThan(densityFor(5).descLines);
  });

  it('never drops below two lines, so a description is never a single fragment', () => {
    for (let n = 1; n <= 12; n++) expect(densityFor(n).descLines).toBeGreaterThanOrEqual(2);
  });
});

describe('normalizeLocation', () => {
  // The bug this fixes: one club's chip read "Room C12" next to others reading
  // "B21" and "B18", so the story looked inconsistent
  it('strips a Room prefix down to the bare code', () => {
    expect(normalizeLocation('Room C12')).toBe('C12');
    expect(normalizeLocation('room b21')).toBe('B21');
    expect(normalizeLocation('Rm. E2A')).toBe('E2A');
    expect(normalizeLocation('Rm 34')).toBe('34');
    expect(normalizeLocation('Room: P23')).toBe('P23');
  });

  it('leaves bare codes and named places alone', () => {
    expect(normalizeLocation('C12')).toBe('C12');
    expect(normalizeLocation('Band Room')).toBe('Band Room');
    expect(normalizeLocation('Room of Requirement')).toBe('Room of Requirement');
    expect(normalizeLocation('Library')).toBe('Library');
  });

  it('handles empty input', () => {
    expect(normalizeLocation('')).toBe('');
    expect(normalizeLocation(null)).toBe('');
    expect(normalizeLocation(undefined)).toBe('');
  });

  it('trims whitespace either way', () => {
    expect(normalizeLocation('  Room C12  ')).toBe('C12');
    expect(normalizeLocation('  B17  ')).toBe('B17');
  });
});

describe('buildPage location normalization', () => {
  const html = (location, count = 1) => buildPage({
    isoDate: '2026-08-24',
    events: Array.from({ length: count }, (_, i) => ev({ club_name: `msjclub${i}`, location })),
    page: 1, totalPages: 1, totalEvents: count
  });

  it('renders "Room C12" from the sheet as a bare C12 chip', () => {
    const out = html('Room C12');
    expect(out).toContain('>C12<');
    expect(out).not.toContain('Room C12');
  });

  it('normalizes on busy pages too, where the chip sits beside the text', () => {
    const out = html('Room C12', 5);
    expect(out).toContain('>C12<');
    expect(out).not.toContain('Room C12');
  });
});

describe('buildIntroPage', () => {
  const out = buildIntroPage();

  it('introduces Hermes in the daily story format', () => {
    expect(out).toContain('Meet<br>Hermes');
    expect(out).toContain('@MSJCLUBS');
    expect(out).toContain('What it looks like');
  });

  it('shows sample rows with bare room codes, matching the daily story', () => {
    expect(out).toContain('>B21<');
    expect(out).toContain('>C12<');
    expect(out).not.toMatch(/Room [A-Z]\d/);
  });

  it('contains no em dashes anywhere in the copy', () => {
    expect(out).not.toContain('—');
    expect(out).not.toContain('&mdash;');
  });

  it('is a complete standalone document at story dimensions', () => {
    expect(out).toContain('<!doctype html>');
    expect(out).toContain('width:1080px');
    expect(out).toContain('height:1920px');
  });
});

describe('buildPage location placement', () => {
  const evs = (n) => Array.from({ length: n }, (_, i) => ({
    club_name: `msjclub${i}`, event_time: 'Lunch',
    location: 'MSJHS Campus - Booth Map Locations',
    description: 'Something happening', confidence: '0.9'
  }));
  const html = (n) => buildPage({
    isoDate: '2026-02-10', events: evs(n), page: 1, totalPages: 1, totalEvents: n
  });

  it('stacks the full location under the description on a quiet page', () => {
    const out = html(1);
    expect(out).toContain('ev-room below');
    expect(out).toContain('MSJHS Campus - Booth Map Locations');
    expect(out).not.toContain('ev-room beside');
  });

  it('puts a truncated chip beside the text on a busy page', () => {
    const out = html(5);
    expect(out).toContain('ev-room beside');
    expect(out).not.toContain('ev-room below');
    expect(out).not.toContain('MSJHS Campus - Booth Map Locations');
  });
});

describe('scaleToFit', () => {
  // A card is SHEET_HEIGHT tall. At scale s its chrome (padding, header, strip,
  // footer) eats `chrome * s` and the events want `content * s`, so this is the
  // geometry the renderer measures on a real page.
  const card = (scale, chrome, content) => ({
    available: SHEET_HEIGHT - chrome * scale,
    content: content * scale
  });

  it('leaves a page that already fits alone', () => {
    const { available, content } = card(1.13, 420, 500);
    expect(scaleToFit(1.13, available, content)).toBe(1.13);
  });

  it('shrinks a page that overflows', () => {
    const { available, content } = card(1.13, 420, 900);
    expect(scaleToFit(1.13, available, content)).toBeLessThan(1.13);
  });

  // The whole point: one measurement of an overflowing page has to land on a
  // scale that actually fits, or the renderer spends passes converging on it.
  it('lands on a scale the content fits at, from a single measurement', () => {
    for (const chrome of [380, 420, 500]) {
      for (const content of [900, 1200, 2000]) {
        const measured = card(1.13, chrome, content);
        const fitted = scaleToFit(1.13, measured.available, measured.content);
        const after = card(fitted, chrome, content);
        expect(after.content).toBeLessThanOrEqual(after.available);
      }
    }
  });

  it('is monotonic: the worse the overflow, the smaller the scale', () => {
    const at = (content) => {
      const m = card(1.13, 420, content);
      return scaleToFit(1.13, m.available, m.content);
    };
    expect(at(1500)).toBeLessThan(at(1000));
  });
});

describe('buildPage type scale', () => {
  const evs = (n) => Array.from({ length: n }, (_, i) => ({
    club_name: `msjclub${i}`, event_time: 'Lunch', location: 'B17', description: 'Meeting'
  }));
  const html = (n, scale) => buildPage({
    isoDate: '2026-02-10', events: evs(n), page: 1, totalPages: 1, totalEvents: n, scale
  });

  it('sizes itself from the event count when no scale is given', () => {
    expect(html(3)).toContain('data-scale="1.13"');
  });

  it('honours an explicit scale', () => {
    expect(html(3, 0.9)).toContain('data-scale="0.9"');
  });

  it('applies the override to the type, not just the attribute', () => {
    // .hd-title is font-size 74 * scale
    expect(html(3, 0.5)).toContain('font-size:37.0px');
  });
});
