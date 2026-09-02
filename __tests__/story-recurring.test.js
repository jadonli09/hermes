import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  DAYS, meetingsOnDate, describeDays, asEvents, validateRecurring, loadRecurring
} from '../story/recurring.js';
import { paginate } from '../story/paginate.js';
import { buildPage } from '../story/template.js';

const lifting = { club: 'Lifting Club', days: ['Tue', 'Thu'], time: 'Lunch', location: 'Weight Room' };
const deca = { club: 'DECA', days: ['Wed'], time: 'After School', location: 'C120' };

describe('meetingsOnDate', () => {
  // 2026-08-25 is a Tuesday, 2026-08-26 a Wednesday
  it('keeps only meetings recurring on that weekday', () => {
    expect(meetingsOnDate([lifting, deca], '2026-08-25')).toEqual([lifting]);
    expect(meetingsOnDate([lifting, deca], '2026-08-26')).toEqual([deca]);
  });

  it('returns nothing on a day no club recurs', () => {
    expect(meetingsOnDate([lifting, deca], '2026-08-28')).toEqual([]);
  });

  it('is timezone-safe at the date boundary', () => {
    // Parsing "2026-08-25" as UTC midnight then reading a local weekday would
    // report Monday anywhere west of Greenwich.
    expect(meetingsOnDate([lifting], '2026-08-25')).toEqual([lifting]);
  });
});

describe('describeDays', () => {
  it('spells out a single day', () => {
    expect(describeDays(['Wed'])).toBe('Every Wednesday');
  });

  it('joins two days with an ampersand', () => {
    expect(describeDays(['Tue', 'Thu'])).toBe('Every Tuesday & Thursday');
  });

  it('lists three or more days with commas', () => {
    expect(describeDays(['Mon', 'Wed', 'Fri'])).toBe('Every Monday, Wednesday & Friday');
  });
});

describe('asEvents', () => {
  it('converts a meeting into a renderable event row', () => {
    const [event] = asEvents([lifting]);
    expect(event.club_name).toBe('Lifting Club');
    expect(event.event_time).toBe('Lunch');
    expect(event.location).toBe('Weight Room');
    expect(event.description).toBe('Every Tuesday & Thursday');
    expect(event.recurring).toBe(true);
  });
});

describe('validateRecurring', () => {
  it('accepts a well-formed list and returns it cleaned', () => {
    const clean = validateRecurring({ meetings: [{ ...lifting, club: '  Lifting Club ' }] });
    expect(clean.meetings).toEqual([lifting]);
  });

  it('normalises day tokens to canonical capitalisation and week order', () => {
    const clean = validateRecurring({ meetings: [{ ...lifting, days: ['thu', 'TUE'] }] });
    expect(clean.meetings[0].days).toEqual(['Tue', 'Thu']);
  });

  it('rejects a missing meetings array', () => {
    expect(() => validateRecurring({})).toThrow(/meetings/);
  });

  it('rejects an empty club name', () => {
    expect(() => validateRecurring({ meetings: [{ ...lifting, club: '  ' }] })).toThrow(/club/i);
  });

  it('rejects an empty or unknown day token', () => {
    expect(() => validateRecurring({ meetings: [{ ...lifting, days: [] }] })).toThrow(/day/i);
    expect(() => validateRecurring({ meetings: [{ ...lifting, days: ['Tuesday'] }] })).toThrow(/day/i);
  });

  it('rejects the same club listed twice for one day', () => {
    const twice = [lifting, { ...lifting, days: ['Thu'], time: 'After School' }];
    expect(() => validateRecurring({ meetings: twice })).toThrow(/Thu/);
  });

  it('allows the same club on different days as separate entries', () => {
    const split = [{ ...lifting, days: ['Tue'] }, { ...lifting, days: ['Thu'], time: 'After School' }];
    expect(() => validateRecurring({ meetings: split })).not.toThrow();
  });
});

describe('loadRecurring', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-recurring-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('returns an empty list when the file does not exist yet', () => {
    expect(loadRecurring(dir)).toEqual([]);
  });

  it('reads and validates the meetings list', () => {
    fs.writeFileSync(path.join(dir, 'recurring.json'), JSON.stringify({ meetings: [lifting, deca] }));
    expect(loadRecurring(dir)).toEqual([lifting, deca]);
  });

  it('throws loudly on a hand-edited file with bad data rather than dropping it', () => {
    fs.writeFileSync(path.join(dir, 'recurring.json'), JSON.stringify({ meetings: [{ ...lifting, days: ['Someday'] }] }));
    expect(() => loadRecurring(dir)).toThrow(/day/i);
  });
});

describe('paginate with a reserved last slot', () => {
  const events = (n) => Array.from({ length: n }, (_, i) => ({ club_name: `c${i}` }));

  it('leaves room on the last page for the recurring strip', () => {
    // 7 events fit one page normally; with a slot reserved they split 4+3
    expect(paginate(events(7), 7, 1).map(p => p.length)).toEqual([4, 3]);
  });

  it('does not add a page when the last one already has room', () => {
    expect(paginate(events(6), 7, 1).map(p => p.length)).toEqual([6]);
  });

  it('keeps the last page under capacity at larger sizes', () => {
    expect(paginate(events(13), 7, 1).map(p => p.length)).toEqual([7, 6]);
    expect(paginate(events(14), 7, 1).map(p => p.length)).toEqual([5, 5, 4]);
  });

  it('loses no events with a reservation in play', () => {
    for (let n = 1; n <= 30; n++) {
      const pages = paginate(events(n), 7, 1);
      expect(pages.flat()).toHaveLength(n);
      expect(pages[pages.length - 1].length).toBeLessThanOrEqual(6);
    }
  });

  it('reserves nothing by default, preserving existing behavior', () => {
    expect(paginate(events(7), 7).map(p => p.length)).toEqual([7]);
  });
});

describe('buildPage recurring strip', () => {
  const ev = (over = {}) => ({
    club_name: 'msjbio', event_time: 'Lunch', location: 'B17',
    description: 'Weekly meeting', ...over
  });
  const base = { isoDate: '2026-08-25', events: [ev()], page: 1, totalPages: 1, totalEvents: 1 };

  it('renders the strip when recurring meetings are passed', () => {
    const html = buildPage({ ...base, recurring: [lifting] });
    expect(html).toContain('Every week');
    expect(html).toContain('Lifting Club');
    expect(html).toContain('Weight Room');
  });

  it('renders no strip when there are no recurring meetings', () => {
    expect(buildPage(base)).not.toContain('Every week');
    expect(buildPage({ ...base, recurring: [] })).not.toContain('Every week');
  });

  it('escapes markup in recurring fields', () => {
    const html = buildPage({ ...base, recurring: [{ ...lifting, club: 'A&B <Club>' }] });
    expect(html).toContain('A&amp;B &lt;Club&gt;');
    expect(html).not.toContain('<Club>');
  });

  it('drops the @ prefix for recurring-derived event rows', () => {
    const html = buildPage({ ...base, events: [ev({ club_name: 'Lifting Club', recurring: true })] });
    expect(html).toContain('Lifting Club');
    expect(html).not.toContain('@Lifting Club');
  });

  it('keeps the @ prefix for scraped events', () => {
    expect(buildPage(base)).toContain('@msjbio');
  });
});
