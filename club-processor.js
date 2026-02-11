// Club processor for handling single club scraping and AI processing
import { scrapeClubPosts } from './scraper.js';
import { processPostWithClaude } from './ai-processor.js';
import { saveProgress } from './utils/progress.js';

/**
 * Utility helper for removing single entries from arrays safely
 */
const removeFromArray = (arr, value) => {
  if (!Array.isArray(arr)) return;
  const index = arr.indexOf(value);
  if (index !== -1) {
    arr.splice(index, 1);
  }
};

/**
 * Processes a single club: scrapes posts and processes them with Claude AI
 * @param {Object} options - Processing options
 * @param {Page} options.page - Playwright page object
 * @param {string} options.clubUsername - Instagram username of the club
 * @param {Date} options.startDate - Start date for filtering
 * @param {Date} options.endDate - End date for filtering
 * @param {Set} options.existingPostUrls - Set of existing post URLs for deduplication
 * @param {Anthropic} options.anthropic - Initialized Anthropic client
 * @param {Object} options.progress - Progress tracking object
 * @param {boolean} options.resumeMode - Whether running in resume mode
 * @param {MetricsCollector} options.metrics - Metrics collector (optional)
 * @returns {Promise<Object>} - Processing result with extracted data
 */
export async function processClub(options) {
  const {
    page,
    clubUsername,
    startDate,
    endDate,
    existingPostUrls,
    anthropic,
    progress,
    resumeMode = false,
    metrics = null
  } = options;

  const results = [];
  let clubSuccess = true;

  try {
    // Scrape posts from club with date range filtering and URL deduplication
    const scrapeResult = await scrapeClubPosts(page, clubUsername, startDate, endDate, existingPostUrls);
    const { newPosts, stoppedAt, totalScraped, duplicatesSkipped, dateChecksSkipped = 0 } = scrapeResult;

    // Record scrape metrics
    if (metrics) {
      metrics.recordClubScrape(clubUsername, scrapeResult);
    }

    // Successful scrape means club should no longer be considered failed
    if (progress.failedClubs && progress.failedClubs.includes(clubUsername)) {
      removeFromArray(progress.failedClubs, clubUsername);
    }

    // Log detailed stats per club
    console.log(`\n📊 Club @${clubUsername} Statistics:`);
    console.log(`  - Posts scraped: ${totalScraped}`);
    console.log(`  - New posts in date range: ${newPosts.length}`);
    console.log(`  - Duplicates skipped: ${duplicatesSkipped}`);
    if (dateChecksSkipped > 0) {
      console.log(`  - Skipped before full extraction: ${dateChecksSkipped} (date out of range)`);
    }
    if (stoppedAt) {
      console.log(`  - Stopped at date: ${stoppedAt} (reached START_DATE boundary)`);
    }

    if (newPosts.length === 0) {
      console.log(`⚠️  No new posts found for @${clubUsername} in date range`);
      // Mark club as processed even if no new posts
      markClubAsProcessed(progress, clubUsername);
      saveProgress(progress);

      if (metrics) {
        metrics.recordClubSuccess(clubUsername);
      }

      return {
        success: true,
        clubUsername,
        results: [],
        stats: {
          totalScraped,
          newPosts: 0,
          duplicatesSkipped,
          dateChecksSkipped,
          postsProcessed: 0,
          apiCallsMade: 0
        }
      };
    }

    // Mark club as processed after successful scraping
    markClubAsProcessed(progress, clubUsername);
    saveProgress(progress);

    // Process each new post with Claude AI
    console.log(`  Processing ${newPosts.length} new post(s) with Claude AI...`);
    let postsProcessed = 0;
    let apiCallsMade = 0;

    for (let j = 0; j < newPosts.length; j++) {
      const post = newPosts[j];
      console.log(`  Processing post ${j + 1}/${newPosts.length}...`);

      try {
        // Skip post if already processed (in resume mode)
        if (resumeMode && progress.processedPosts && progress.processedPosts.includes(post.postUrl)) {
          console.log(`  ⏭️  Skipping already processed post: ${post.postUrl}`);
          continue;
        }

        // Process post with Claude (pass page for image fetching)
        // May return single object OR array (for multi-day events)
        const result = await processPostWithClaude(anthropic, post, page);
        apiCallsMade++;

        if (metrics) {
          metrics.recordApiCall(clubUsername);
        }

        // Handle both single result and array (multi-day events)
        const resultArray = Array.isArray(result) ? result : [result];
        let addedCount = 0;

        for (const eventResult of resultArray) {
          // Only add results that have some useful data (not all null)
          if (eventResult.event_date || eventResult.event_time || eventResult.event_type || eventResult.location) {
            results.push(eventResult);
            addedCount++;

            // Log needs_review flag if present
            if (eventResult.needs_review) {
              console.log(`  ⚠️  Multi-day event flagged for review (may have missed days)`);
            }
          }
        }

        if (addedCount > 0) {
          postsProcessed++;
          progress.totalPostsProcessed++;

          if (metrics) {
            metrics.recordPostProcessed(clubUsername);
          }

          // Mark post as processed
          if (progress.processedPosts && !progress.processedPosts.includes(post.postUrl)) {
            progress.processedPosts.push(post.postUrl);
          }

          // Save progress after each successful post
          saveProgress(progress);

          if (resultArray.length > 1) {
            console.log(`  ✓ Extracted ${addedCount} events from multi-day post`);
          } else {
            const firstResult = resultArray[0];
            console.log(`  ✓ Extracted event info: ${firstResult.event_date || 'N/A'} ${firstResult.event_time || 'N/A'}`);
          }
        } else {
          console.log(`  ⚠️  No event information extracted from post`);
        }
      } catch (error) {
        console.error(`  ✗ Error processing post: ${error.message}`);
        // Continue with next post
      }
    }

    if (metrics) {
      metrics.recordClubSuccess(clubUsername);
    }

    return {
      success: true,
      clubUsername,
      results,
      stats: {
        totalScraped,
        newPosts: newPosts.length,
        duplicatesSkipped,
        dateChecksSkipped,
        postsProcessed,
        apiCallsMade
      }
    };

  } catch (error) {
    clubSuccess = false;

    // Mark club as failed
    if (progress.failedClubs && !progress.failedClubs.includes(clubUsername)) {
      progress.failedClubs.push(clubUsername);
    }
    saveProgress(progress);

    if (metrics) {
      metrics.recordClubFailure(clubUsername, error.message);
    }

    // Check if error is related to Instagram blocking
    if (error.message.includes('blocking') || error.message.includes('challenge') ||
        error.message.includes('rate limit') || error.message.includes('restricted')) {
      console.error(`✗ Instagram blocking detected for @${clubUsername}: ${error.message}`);
      console.error('  → Consider waiting before retrying or checking account status');
    } else {
      console.error(`✗ Error processing club @${clubUsername}: ${error.message}`);
    }

    return {
      success: false,
      clubUsername,
      results: [],
      error: error.message,
      stats: {
        totalScraped: 0,
        newPosts: 0,
        duplicatesSkipped: 0,
        dateChecksSkipped: 0,
        postsProcessed: 0,
        apiCallsMade: 0
      }
    };
  }
}

/**
 * Marks a club as processed in the progress object
 * @param {Object} progress - Progress tracking object
 * @param {string} clubUsername - Club username
 */
function markClubAsProcessed(progress, clubUsername) {
  if (!progress.processedClubs) {
    progress.processedClubs = [];
  }
  if (!progress.processedClubs.includes(clubUsername)) {
    progress.processedClubs.push(clubUsername);
    progress.totalClubsProcessed = (progress.totalClubsProcessed || 0) + 1;
    progress.lastProcessedClub = clubUsername;
  }
}

/**
 * Checks if club has any blocking indicators
 * @param {string} errorMessage - Error message to check
 * @returns {boolean} - True if blocking detected
 */
export function isBlockingError(errorMessage) {
  if (!errorMessage) return false;
  const blockingIndicators = [
    'blocking',
    'challenge',
    'rate limit',
    'restricted',
    'suspicious',
    'try again later',
    'too many requests'
  ];
  const lowerMessage = errorMessage.toLowerCase();
  return blockingIndicators.some(indicator => lowerMessage.includes(indicator));
}
