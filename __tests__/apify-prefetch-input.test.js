// Covers the actor input prefetch() builds. The rest of the Apify suite seeds
// postsByAccount directly, which never exercises what we actually send - and the
// input is where the money is: a wrong resultsLimit or a missing skipPinnedPosts
// is billed on every run and is invisible in the output.
import { jest } from '@jest/globals';

const runActor = jest.fn();

jest.unstable_mockModule('../scrapers/apify-client.js', () => ({ runActor, acknowledgeActorRun: jest.fn() }));

const { ApifyScraper } = await import('../scrapers/apify-scraper.js');

describe('ApifyScraper.prefetch actor input', () => {
  const startDate = new Date(Date.UTC(2026, 6, 20));

  beforeEach(() => {
    runActor.mockReset();
    runActor.mockResolvedValue([]);
  });

  const inputFor = async (scraper, usernames = ['msjbio', 'msjclubs']) => {
    await scraper.prefetch(usernames, startDate);
    expect(runActor).toHaveBeenCalledTimes(1);
    return runActor.mock.calls[0][0];
  };

  it('asks the actor to skip pinned posts', async () => {
    const { input } = await inputFor(new ApifyScraper({ token: 't' }));

    // Pinned posts count against resultsLimit and ignore onlyPostsNewerThan, so
    // without this we pay for old posts we discard locally.
    expect(input.skipPinnedPosts).toBe(true);
  });

  it('sends the usernames, results limit and date window', async () => {
    const scraper = new ApifyScraper({ token: 't', resultsLimit: 10 });
    const { input } = await inputFor(scraper);

    expect(input).toEqual({
      username: ['msjbio', 'msjclubs'],
      resultsLimit: 10,
      onlyPostsNewerThan: '2026-07-20',
      skipPinnedPosts: true
    });
  });

  it('caps billed items at what the input can return', async () => {
    const scraper = new ApifyScraper({ token: 't', resultsLimit: 10 });
    const call = await inputFor(scraper, ['a', 'b', 'c']);

    expect(call.maxItems).toBe(30);
  });

  it('forwards the token, actor id and spend ceiling', async () => {
    const scraper = new ApifyScraper({
      token: 'secret',
      actorId: 'apify/instagram-post-scraper',
      maxTotalChargeUsd: 5
    });
    const call = await inputFor(scraper);

    expect(call).toMatchObject({
      token: 'secret',
      actorId: 'apify/instagram-post-scraper',
      maxTotalChargeUsd: 5
    });
  });
});

describe('strict scheduled coverage', () => {
  beforeEach(() => { runActor.mockReset(); process.env.HERMES_STRICT_REFRESH = 'true'; process.env.HERMES_FETCH_SINCE = '2026-10-16T06:00:00.000Z'; });
  afterEach(() => { delete process.env.HERMES_STRICT_REFRESH; delete process.env.HERMES_FETCH_SINCE; });
  const post = (id, timestamp) => ({ url: `https://www.instagram.com/p/${id}/`, timestamp, inputUrl: 'https://www.instagram.com/club/', displayUrl: 'https://cdn.test/a.jpg' });
  it('accepts three distinct weekend days under the user rate assumption without buying another run', async () => {
    runActor.mockResolvedValue([post('A', '2026-10-16T20:00:00Z'), post('B', '2026-10-17T20:00:00Z'), post('C', '2026-10-18T20:00:00Z')]);
    const s = new ApifyScraper({ token: 'fake', resultsLimit: 3 });
    await s.prefetch(['club'], new Date('2026-10-16'));
    expect(s.postsByAccount.get('club')).toHaveLength(3);
    expect(runActor).toHaveBeenCalledTimes(1);
    expect(runActor.mock.calls[0][0].input.onlyPostsNewerThan).toBe('2026-10-16T06:00:00.000Z');
  });
  it('reports rate deviations as advisories but still rejects explicit account errors', async () => {
    runActor.mockResolvedValue([post('A', '2026-10-16T20:00:00Z'), post('B', '2026-10-16T21:00:00Z')]);
    const scraper = new ApifyScraper({ token: 'fake', resultsLimit: 3 });
    await scraper.prefetch(['club'], new Date('2026-10-16'));
    expect(scraper.coverage.accounts.club.advisories).toContain('daily-rate-exceeded');
    expect(scraper.coverage.accounts.club.reasons).not.toContain('daily-rate-exceeded');
    runActor.mockResolvedValue([{ error: 'profile failed' }]);
    await expect(new ApifyScraper({ token: 'fake' }).prefetch(['club'], new Date('2026-10-16'))).rejects.toThrow(/account errors/);
  });
  it('deduplicates duplicate dataset rows before extraction and rate checks', async () => {
    const item = post('A', '2026-10-16T20:00:00Z'); runActor.mockResolvedValue([item, item]);
    const s = new ApifyScraper({ token: 'fake', resultsLimit: 3 }); await s.prefetch(['club'], new Date('2026-10-16'));
    expect(s.postsByAccount.get('club')).toHaveLength(1);
  });
});

test('best effort retains valid posts but exposes blocked and absent account gaps', async () => {
  process.env.HERMES_COVERAGE_MODE = 'best-effort';
  try {
    runActor.mockReset(); runActor.mockResolvedValue([
      { inputUrl:'https://www.instagram.com/good', ownerUsername:'good', url:'https://www.instagram.com/p/abc/', timestamp:'2026-07-20T12:00:00Z', displayUrl:'https://example.com/image.png' },
      { inputUrl:'https://www.instagram.com/blocked', error:'no_items', errorDescription:'Empty or private data for provided input', requestErrorMessages:['Request got blocked'] }
    ]);
    const scraper = new ApifyScraper({token:'t',resultsLimit:3});
    await scraper.prefetch(['good','blocked','absent'],new Date('2026-07-20T00:00:00Z'));
    expect(scraper.coverage?.accounts.blocked.status).toBe('blocked');
    expect(scraper.coverage?.accounts.absent.status).toBe('absent-input');
    expect(scraper.postsByAccount.get('good')).toHaveLength(1);
    expect(scraper.coverage.complete).toBe(false);
  } finally { delete process.env.HERMES_COVERAGE_MODE; }
});
