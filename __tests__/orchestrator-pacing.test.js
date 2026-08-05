import { ScrapingOrchestrator } from '../scraping-orchestrator.js';

// The delay only matters for backends that talk to Instagram per club. Apify has
// already fetched everything by the time this loop runs, so pacing there is pure
// dead time - ~4 minutes across 85 accounts on every run.
const build = (needsPacing) => {
  const o = new ScrapingOrchestrator({
    config: { startDate: new Date(), endDate: new Date(), delayBetweenClubs: 3000 },
    progress: { processedClubs: [], processedPosts: [], failedClubs: [] },
    needsPacing,
    scrapeClubPosts: async () => ({ newPosts: [], stoppedAt: null, totalScraped: 0, duplicatesSkipped: 0, dateChecksSkipped: 0 })
  });
  return o;
};

describe('inter-club pacing', () => {
  it('skips the delay when the backend prefetched (apify)', async () => {
    const t = Date.now();
    await build(false).processSequentially(['a', 'b', 'c'], null);
    expect(Date.now() - t).toBeLessThan(1000);   // would be ~6s if it slept
  });

  it('defaults to pacing when the option is not supplied', () => {
    expect(new ScrapingOrchestrator({}).needsPacing).toBe(true);
  });

  it('paces when the backend drives a browser (playwright)', () => {
    expect(build(true).needsPacing).toBe(true);
  });
});
