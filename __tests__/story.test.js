import { timeRank, sortEvents, paginate, scaleFor, groupByTime, MAX_PER_PAGE } from '../story/paginate.js';
import { isPublishable, eventsOnDate } from '../story/event-source.js';
import { monogram } from '../story/avatars.js';
import { escapeHtml, formatHeading, densityFor, buildPage } from '../story/template.js';

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
    expect(groupByTime([ev({ event_time: '' })])[0].time).toBe('All day');
  });
});

describe('isPublishable', () => {
  it('drops announcements, matching what the calendar already excludes', () => {
    expect(isPublishable(ev({ event_type: 'Announcement' }))).toBe(false);
    expect(isPublishable(ev({ event_type: 'announcement' }))).toBe(false);
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
