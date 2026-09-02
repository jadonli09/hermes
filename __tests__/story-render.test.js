// Browser-backed checks. Slower than the pure unit tests, but these guard the
// failures that are invisible in HTML review: silently-unloaded fonts, content
// drifting under Instagram's UI chrome, and a card whose contents overrun it.
import { jest } from '@jest/globals';
import { buildPage, shortLocation, WIDTH, HEIGHT } from '../story/template.js';
import { scaleFor } from '../story/paginate.js';
import { renderPages, renderFitted, inspectFonts, inspectLayout } from '../story/render.js';

jest.setTimeout(120000);

const events = (n) => Array.from({ length: n }, (_, i) => ({
  club_name: `msjclub${i}`,
  event_time: i % 2 ? 'Lunch' : 'After School',
  location: `B${10 + i}`,
  description: `Event number ${i + 1}`,
  confidence: '0.9'
}));

const page = (n) => buildPage({
  isoDate: '2026-02-10', events: events(n), page: 1, totalPages: 1, totalEvents: n
});

describe('shortLocation', () => {
  it('leaves a room code untouched', () => {
    expect(shortLocation('B17', 1)).toBe('B17');
    expect(shortLocation('A-Wing', 1.3)).toBe('A-Wing');
  });

  it('truncates a long location so the chip stays one line', () => {
    const out = shortLocation('MSJHS Campus - Booth Map Locations', 1);
    expect(out.length).toBeLessThanOrEqual(18);
    expect(out.endsWith('…')).toBe(true);
  });

  // The chip should occupy a roughly constant width, so larger type gets fewer
  // characters rather than a wider chip that squeezes the description
  it('allows fewer characters as type scales up', () => {
    const long = 'MSJHS Campus - Booth Map Locations';
    expect(shortLocation(long, 1.30).length).toBeLessThan(shortLocation(long, 1.00).length);
    expect(shortLocation(long, 1.00).length).toBeLessThan(shortLocation(long, 0.87).length);
  });

  it('handles an empty location', () => {
    expect(shortLocation('', 1)).toBe('');
    expect(shortLocation(null, 1)).toBe('');
  });
});

describe('rendering', () => {
  it('produces an image at exactly Instagram story dimensions', async () => {
    const [buffer] = await renderPages([page(5)]);

    // PNG header: width and height are big-endian uint32 at offsets 16 and 20
    expect(buffer.readUInt32BE(16)).toBe(WIDTH);
    expect(buffer.readUInt32BE(20)).toBe(HEIGHT);
  });

  // Regression guard: setContent leaves an about:blank origin, which blocks the
  // file:// font requests. The page still renders, just in fallback system sans.
  it('loads all three brand fonts', async () => {
    const fonts = await inspectFonts(page(3));
    const byFamily = Object.fromEntries(fonts.map(f => [f.family, f.status]));

    expect(byFamily.GeneralSans).toBe('loaded');
    expect(byFamily.Satoshi).toBe('loaded');
    expect(byFamily.JBMono).toBe('loaded');
  });

  it('renders every page of a multi-page day', async () => {
    const buffers = await renderPages([page(4), page(4)]);
    expect(buffers).toHaveLength(2);
    buffers.forEach(b => expect(b.readUInt32BE(20)).toBe(HEIGHT));
  });

  it('returns nothing when given no pages', async () => {
    expect(await renderPages([])).toEqual([]);
  });
});

// A day whose captions each run to the full three-line clamp, with a standing
// meeting riding along underneath. This is the 2026-09-01 card: at its natural
// 1.13x it wants about 160px more than the card has.
const dense = (scale) => buildPage({
  isoDate: '2026-09-01',
  events: [0, 1, 2, 3].map(i => ({
    club_name: `msjclub${i}`,
    event_time: i < 3 ? 'Lunch' : '',
    location: `B${10 + i}`,
    description: 'An introductory meeting with free food, a full officer panel, sign ups ' +
      'for the fall service drive, and a short lecture for anyone who wants to know what ' +
      'the club actually does all year.'
  })),
  page: 1,
  totalPages: 1,
  totalEvents: 4,
  recurring: [{ club: 'Lifting Club', days: ['Tue'], time: 'Lunch', location: 'Weight Room' }],
  scale
});

const roomy = (scale) => buildPage({
  isoDate: '2026-09-01', page: 1, totalPages: 1, totalEvents: 1, scale,
  events: [{ club_name: 'msjbio', event_time: 'Lunch', location: 'B17', description: 'Weekly meeting.' }]
});

describe('card containment', () => {
  // The bug this fixes: the events column could not shrink, so a dense day
  // pushed the standing-meeting strip through the bottom of the card and left
  // the footer rule floating on the background below it.
  it('keeps the strip and footer inside the card even when the events overflow', async () => {
    const layout = await inspectLayout(dense(null));

    expect(layout.overflow).toBeGreaterThan(0);
    expect(layout.recurring.bottom).toBeLessThanOrEqual(layout.sheet.bottom);
    expect(layout.footer.bottom).toBeLessThanOrEqual(layout.sheet.bottom);
  });

  // The bug this fixes: a flex row cannot ellipsize its own children, so a long
  // club name ran to the edge and shoved the room code - the point of the line -
  // clean out of view.
  it('shortens a long club name rather than pushing the room code off the row', async () => {
    const layout = await inspectLayout(buildPage({
      isoDate: '2026-09-01', page: 1, totalPages: 1, totalEvents: 1,
      events: [{ club_name: 'msjbio', event_time: 'Lunch', location: 'B17', description: 'Meeting.' }],
      recurring: [{
        club: 'Model United Nations and Debate Society of Mission San Jose',
        days: ['Tue'], time: 'After School', location: 'Multipurpose Room'
      }]
    }));

    expect(layout.strip[0].overflow).toBe(0);
    expect(layout.strip[0].roomVisible).toBe(true);
  });

  it('leaves a page with room to spare untouched', async () => {
    const layout = await inspectLayout(roomy(null));

    expect(layout.overflow).toBe(0);
    expect(layout.footer.bottom).toBeLessThanOrEqual(layout.sheet.bottom);
  });
});

describe('renderFitted', () => {
  it('shrinks an overflowing page until nothing is clipped', async () => {
    const { images, scales } = await renderFitted([dense]);

    expect(images).toHaveLength(1);
    expect(scales[0]).toBeLessThan(scaleFor(4));

    const layout = await inspectLayout(dense(scales[0]));
    expect(layout.overflow).toBe(0);
    expect(layout.recurring.bottom).toBeLessThanOrEqual(layout.sheet.bottom);
    expect(layout.footer.bottom).toBeLessThanOrEqual(layout.sheet.bottom);
  });

  it('leaves a page that already fits at its natural size', async () => {
    const { scales } = await renderFitted([roomy]);
    expect(scales[0]).toBeNull();
  });

  it('fits each page independently and returns one image per page', async () => {
    const { images, scales } = await renderFitted([roomy, dense]);

    expect(images).toHaveLength(2);
    expect(scales[0]).toBeNull();
    expect(scales[1]).toBeLessThan(scaleFor(4));
    images.forEach(b => expect(b.readUInt32BE(20)).toBe(HEIGHT));
  });

  it('returns nothing when given no pages', async () => {
    expect(await renderFitted([])).toEqual({ images: [], scales: [] });
  });
});
