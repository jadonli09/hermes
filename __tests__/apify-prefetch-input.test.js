// Covers the actor input prefetch() builds. The rest of the Apify suite seeds
// postsByAccount directly, which never exercises what we actually send - and the
// input is where the money is: a wrong resultsLimit or a missing skipPinnedPosts
// is billed on every run and is invisible in the output.
import { jest } from '@jest/globals';

const runActor = jest.fn();

jest.unstable_mockModule('../scrapers/apify-client.js', () => ({ runActor }));

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
