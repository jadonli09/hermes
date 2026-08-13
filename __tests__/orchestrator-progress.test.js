import { setSink, resetSink } from '../utils/progress-events.js';
import { ScrapingOrchestrator } from '../scraping-orchestrator.js';

describe('orchestrator progress events', () => {
  let events;

  beforeEach(() => {
    events = [];
    process.env.HERMES_PROGRESS = 'json';
    setSink(line => events.push(JSON.parse(line)));
  });

  afterEach(() => {
    resetSink();
    delete process.env.HERMES_PROGRESS;
  });

  const orchestratorFor = (scrapeClubPosts) => new ScrapingOrchestrator({
    config: {
      startDate: new Date('2026-08-05'),
      endDate: new Date('2026-08-12'),
      delayBetweenClubs: 0
    },
    anthropic: {},
    progress: { processedClubs: [], processedPosts: [], failedClubs: [], totalPostsProcessed: 0 },
    existingPostUrls: new Set(),
    needsPacing: false,
    scrapeClubPosts
  });

  it('emits a start and a done event per club', async () => {
    const orchestrator = orchestratorFor(async () => ({
      newPosts: [], stoppedAt: null, totalScraped: 4, duplicatesSkipped: 1, dateChecksSkipped: 0
    }));

    await orchestrator.processSequentially(['msjbio', 'msjchemclub'], null);

    expect(events.map(e => e.t)).toEqual(['club:start', 'club:done', 'club:start', 'club:done']);
    expect(events[0]).toMatchObject({ index: 1, total: 2, account: 'msjbio' });
    expect(events[1]).toMatchObject({ account: 'msjbio', postsFound: 4, eventsExtracted: 0 });
    expect(typeof events[1].durationMs).toBe('number');
    expect(events[2]).toMatchObject({ index: 2, total: 2, account: 'msjchemclub' });
  });

  it('emits club:error when a club fails', async () => {
    const orchestrator = orchestratorFor(async () => { throw new Error('Apify API 402'); });

    await orchestrator.processSequentially(['msjbio'], null);

    const error = events.find(e => e.t === 'club:error');
    expect(error).toMatchObject({ index: 1, total: 1, account: 'msjbio' });
    expect(error.message).toContain('402');
  });

  it('emits nothing when HERMES_PROGRESS is unset', async () => {
    delete process.env.HERMES_PROGRESS;

    const orchestrator = orchestratorFor(async () => ({
      newPosts: [], stoppedAt: null, totalScraped: 0, duplicatesSkipped: 0, dateChecksSkipped: 0
    }));

    await orchestrator.processSequentially(['msjbio'], null);
    expect(events).toEqual([]);
  });
});
