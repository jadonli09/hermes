import { jest } from '@jest/globals';
import { normalizeApifyPost, accountFromInputUrl, ApifyScraper } from '../scrapers/apify-scraper.js';

const item = (over = {}) => ({
  url: 'https://www.instagram.com/p/ABC123/',
  timestamp: '2026-07-28T18:30:00.000Z',
  caption: 'Club meeting Tuesday at lunch in B17',
  ownerUsername: 'msjbio',
  inputUrl: 'https://www.instagram.com/msjbio/',
  displayUrl: 'https://scontent.cdninstagram.com/img1.jpg',
  ...over
});

describe('accountFromInputUrl', () => {
  it('extracts the username from a profile URL', () => {
    expect(accountFromInputUrl('https://www.instagram.com/msjwarriors/')).toBe('msjwarriors');
  });

  it('handles a URL with no trailing slash and a query string', () => {
    expect(accountFromInputUrl('https://instagram.com/msj.pickleball?hl=en')).toBe('msj.pickleball');
  });

  it('returns null for missing or unparseable input', () => {
    expect(accountFromInputUrl(null)).toBeNull();
    expect(accountFromInputUrl('not a url')).toBeNull();
  });
});

describe('normalizeApifyPost', () => {
  it('maps an Apify item onto the pipeline post shape', () => {
    expect(normalizeApifyPost(item())).toEqual({
      postUrl: 'https://www.instagram.com/p/ABC123/',
      imageUrls: ['https://scontent.cdninstagram.com/img1.jpg'],
      caption: 'Club meeting Tuesday at lunch in B17',
      accountName: 'msjbio',
      postDate: '2026-07-28'
    });
  });

  it('prefers the carousel images array over displayUrl', () => {
    const post = normalizeApifyPost(item({ images: ['a.jpg', 'b.jpg', 'c.jpg'] }));
    expect(post.imageUrls).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
  });

  it('falls back to displayUrl when images is empty', () => {
    expect(normalizeApifyPost(item({ images: [] })).imageUrls)
      .toEqual(['https://scontent.cdninstagram.com/img1.jpg']);
  });

  it('normalizes a missing caption to null rather than undefined', () => {
    expect(normalizeApifyPost(item({ caption: undefined })).caption).toBeNull();
  });

  it('rejects items missing a url or timestamp', () => {
    expect(normalizeApifyPost(item({ url: undefined }))).toBeNull();
    expect(normalizeApifyPost(item({ timestamp: undefined }))).toBeNull();
    expect(normalizeApifyPost(null)).toBeNull();
  });

  it('rejects an unparseable timestamp instead of emitting an invalid date', () => {
    expect(normalizeApifyPost(item({ timestamp: 'not-a-date' }))).toBeNull();
  });

  // Instagram collab posts show on a club's grid but are owned by the co-author.
  // Attributing to the owner would drop them: nothing ever reads that bucket.
  it('attributes a collab post to the scraped profile, not the post owner', () => {
    const post = normalizeApifyPost(item({
      ownerUsername: 'msjclubs',
      inputUrl: 'https://www.instagram.com/msjwarriors/'
    }));
    expect(post.accountName).toBe('msjwarriors');
  });

  it('falls back to ownerUsername when inputUrl is absent', () => {
    expect(normalizeApifyPost(item({ inputUrl: undefined })).accountName).toBe('msjbio');
  });

  it('derives postDate in UTC so it matches the sheet format', () => {
    // Late-evening UTC must not roll backwards into the previous day
    expect(normalizeApifyPost(item({ timestamp: '2026-07-28T23:59:00.000Z' })).postDate)
      .toBe('2026-07-28');
  });
});

describe('ApifyScraper.scrapeClubPosts', () => {
  const start = new Date(Date.UTC(2026, 6, 20));
  const end = new Date(Date.UTC(2026, 7, 20));

  const seeded = (posts) => {
    const s = new ApifyScraper({ token: 't' });
    s.prefetched = true;
    s.postsByAccount.set('msjbio', posts.map(normalizeApifyPost));
    return s;
  };

  it('returns posts in range with the scraper result contract', async () => {
    const s = seeded([item()]);
    const r = await s.scrapeClubPosts(null, 'msjbio', start, end, new Set());

    expect(r.newPosts).toHaveLength(1);
    expect(r).toMatchObject({
      stoppedAt: null,
      totalScraped: 1,
      duplicatesSkipped: 0,
      dateChecksSkipped: 0
    });
  });

  it('skips URLs already in the spreadsheet', async () => {
    const s = seeded([item()]);
    const existing = new Set(['https://www.instagram.com/p/ABC123/']);
    const r = await s.scrapeClubPosts(null, 'msjbio', start, end, existing);

    expect(r.newPosts).toHaveLength(0);
    expect(r.duplicatesSkipped).toBe(1);
  });

  it('drops posts outside the date range on both ends', async () => {
    const s = seeded([
      item({ url: 'https://www.instagram.com/p/OLD/', timestamp: '2026-01-01T00:00:00.000Z' }),
      item({ url: 'https://www.instagram.com/p/FUTURE/', timestamp: '2027-01-01T00:00:00.000Z' })
    ]);
    const r = await s.scrapeClubPosts(null, 'msjbio', start, end, new Set());

    expect(r.newPosts).toHaveLength(0);
    // Out-of-range is not a duplicate; keep the two counters distinct
    expect(r.duplicatesSkipped).toBe(0);
  });

  it('keeps a post landing exactly on the start boundary', async () => {
    const s = seeded([item({ timestamp: '2026-07-20T00:00:00.000Z' })]);
    const r = await s.scrapeClubPosts(null, 'msjbio', start, end, new Set());
    expect(r.newPosts).toHaveLength(1);
  });

  it('matches usernames case-insensitively', async () => {
    const s = seeded([item()]);
    const r = await s.scrapeClubPosts(null, 'MSJBio', start, end, new Set());
    expect(r.newPosts).toHaveLength(1);
  });

  it('returns an empty result for an account the actor never covered', async () => {
    const s = seeded([item()]);
    const r = await s.scrapeClubPosts(null, 'nonexistentclub', start, end, new Set());

    expect(r.newPosts).toHaveLength(0);
    expect(r.totalScraped).toBe(0);
  });

  it('throws if used before prefetch, rather than silently reporting zero posts', async () => {
    const s = new ApifyScraper({ token: 't' });
    await expect(s.scrapeClubPosts(null, 'msjbio', start, end, new Set()))
      .rejects.toThrow(/prefetch/);
  });
});

describe('ApifyScraper date-range reporting', () => {
  const start = new Date(Date.UTC(2026, 6, 27));
  const end = new Date(Date.UTC(2027, 7, 3));

  it('counts out-of-range posts instead of dropping them silently', async () => {
    const s = new ApifyScraper({ token: 't' });
    s.prefetched = true;
    s.postsByAccount.set('msjclubs', [
      normalizeApifyPost(item({ url: 'https://www.instagram.com/p/PINNED1/', timestamp: '2026-03-01T00:00:00Z', inputUrl: 'https://www.instagram.com/msjclubs/' })),
      normalizeApifyPost(item({ url: 'https://www.instagram.com/p/PINNED2/', timestamp: '2026-05-01T00:00:00Z', inputUrl: 'https://www.instagram.com/msjclubs/' })),
      normalizeApifyPost(item({ url: 'https://www.instagram.com/p/RECENT/',  timestamp: '2026-08-01T00:00:00Z', inputUrl: 'https://www.instagram.com/msjclubs/' }))
    ]);

    const r = await s.scrapeClubPosts(null, 'msjclubs', start, end, new Set());
    expect(r.newPosts).toHaveLength(1);
    expect(r.dateChecksSkipped).toBe(2);
    expect(r.totalScraped).toBe(3);
  });
});
