import { isSameEvent } from '../sheets-writer.js';

// Shape as it comes back from the sheet: dates are MM/DD/YYYY
const row = (over = {}) => ({
  club_name: 'msjdeca',
  event_date: '08/06/2026',
  post_url: 'https://www.instagram.com/p/DbjGuHeD0Zi/',
  ...over
});

// Shape as produced by the extractor: dates are YYYY-MM-DD
const incoming = (over = {}) => ({
  club_name: 'msjdeca',
  event_date: '2026-08-06',
  post_url: 'https://www.instagram.com/p/DbjGuHeD0Zi/',
  ...over
});

describe('isSameEvent', () => {
  it('matches across the sheet and extractor date formats', () => {
    expect(isSameEvent(row(), incoming())).toBe(true);
  });

  // The bug this exists to prevent: a 2-day event whose days both carry the
  // same post_url must not be treated as one row, or day 2 overwrites day 1.
  it('does not match two different days of the same multi-day post', () => {
    expect(isSameEvent(row({ event_date: '08/06/2026' }), incoming({ event_date: '2026-08-07' })))
      .toBe(false);
  });

  // Collab posts: one post scraped from two clubs produces two rows
  it('does not match two clubs sharing one collab post', () => {
    expect(isSameEvent(row({ club_name: 'msjdeca' }), incoming({ club_name: 'msjleoclub' })))
      .toBe(false);
  });

  it('does not match different posts', () => {
    expect(isSameEvent(row(), incoming({ post_url: 'https://www.instagram.com/p/OTHER/' })))
      .toBe(false);
  });

  it('ignores club name casing and surrounding whitespace', () => {
    expect(isSameEvent(row({ club_name: ' MSJDeca ' }), incoming())).toBe(true);
  });

  it('treats two undated events on the same post as the same event', () => {
    expect(isSameEvent(row({ event_date: '' }), incoming({ event_date: null }))).toBe(true);
  });

  it('does not match a dated event against an undated one', () => {
    expect(isSameEvent(row({ event_date: '' }), incoming())).toBe(false);
  });

  it('tolerates whitespace around the post url', () => {
    expect(isSameEvent(row(), incoming({ post_url: '  https://www.instagram.com/p/DbjGuHeD0Zi/  ' })))
      .toBe(true);
  });
});
