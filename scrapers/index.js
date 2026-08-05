// Scraper backend factory.
//
// Both backends expose the same method:
//   scrapeClubPosts(page, clubUsername, startDate, endDate, existingUrls)
//     -> { newPosts, stoppedAt, totalScraped, duplicatesSkipped, dateChecksSkipped }
// where each post is { postUrl, imageUrls[], caption, accountName, postDate }.
//
// Anything downstream of the scraper works against that contract only, so
// switching backends does not touch the AI, sheets, or metrics layers.
import { scrapeClubPosts as playwrightScrapeClubPosts } from '../scraper.js';
import { createApifyScraper } from './apify-scraper.js';

export const BACKENDS = ['apify', 'playwright'];

/**
 * @param {Object} config - Config from loadConfig()
 * @returns {Object} - { name, requiresBrowser, scrapeClubPosts, prefetch? }
 */
export function createScraperBackend(config) {
  const name = config.scraperBackend || 'playwright';

  if (!BACKENDS.includes(name)) {
    throw new Error(
      `Unknown SCRAPER_BACKEND "${name}". Supported: ${BACKENDS.join(', ')}`
    );
  }

  if (name === 'playwright') {
    return {
      name,
      requiresBrowser: true,
      scrapeClubPosts: playwrightScrapeClubPosts
    };
  }

  if (!config.apifyToken) {
    throw new Error('APIFY_TOKEN must be set when SCRAPER_BACKEND=apify');
  }

  const scraper = createApifyScraper({
    token: config.apifyToken,
    actorId: config.apifyActorId,
    resultsLimit: config.apifyResultsLimit,
    maxTotalChargeUsd: config.apifyMaxChargeUsd
  });

  return {
    name,
    requiresBrowser: false,
    prefetch: (usernames, startDate) => scraper.prefetch(usernames, startDate),
    scrapeClubPosts: (page, club, start, end, existing) =>
      scraper.scrapeClubPosts(page, club, start, end, existing)
  };
}
