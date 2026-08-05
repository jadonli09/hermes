// Browser-backed checks. Slower than the pure unit tests, but these guard the
// two failures that are invisible in HTML review: silently-unloaded fonts and
// content drifting under Instagram's UI chrome.
import { jest } from '@jest/globals';
import { buildPage, shortLocation, WIDTH, HEIGHT } from '../story/template.js';
import { renderPages, inspectFonts } from '../story/render.js';

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
