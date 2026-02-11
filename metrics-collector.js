// Metrics collector for tracking scraping and processing statistics
import fs from 'fs';
import path from 'path';

/**
 * Metrics collector class for tracking scraping statistics
 */
export class MetricsCollector {
  constructor() {
    this.reset();
  }

  /**
   * Resets all metrics to initial values
   */
  reset() {
    this.metrics = {
      // Club metrics
      totalClubs: 0,
      clubsProcessed: 0,
      clubsFailed: 0,
      failedClubsList: [],

      // Post metrics
      totalPostsScraped: 0,
      totalPostsProcessed: 0,
      totalNewPostsAdded: 0,
      totalDuplicatesSkipped: 0,
      totalDateChecksSkipped: 0,

      // API metrics
      totalApiCallsMade: 0,

      // Timing metrics
      startTime: null,
      endTime: null,

      // Per-club metrics
      clubStats: {}
    };
  }

  /**
   * Starts the metrics collection timer
   */
  start() {
    this.metrics.startTime = new Date();
  }

  /**
   * Ends the metrics collection timer
   */
  end() {
    this.metrics.endTime = new Date();
  }

  /**
   * Sets the total number of clubs to process
   * @param {number} count - Total clubs
   */
  setTotalClubs(count) {
    this.metrics.totalClubs = count;
  }

  /**
   * Records metrics for a successful club scrape
   * @param {string} clubUsername - Club username
   * @param {Object} scrapeResult - Result from scrapeClubPosts
   */
  recordClubScrape(clubUsername, scrapeResult) {
    const { totalScraped = 0, duplicatesSkipped = 0, dateChecksSkipped = 0, newPosts = [] } = scrapeResult;

    this.metrics.totalPostsScraped += totalScraped;
    this.metrics.totalDuplicatesSkipped += duplicatesSkipped;
    this.metrics.totalDateChecksSkipped += dateChecksSkipped;

    this.metrics.clubStats[clubUsername] = {
      postsScraped: totalScraped,
      newPostsFound: newPosts.length,
      duplicatesSkipped,
      dateChecksSkipped,
      postsProcessed: 0,
      apiCallsMade: 0,
      success: true
    };
  }

  /**
   * Records a successful post processing
   * @param {string} clubUsername - Club username
   */
  recordPostProcessed(clubUsername) {
    this.metrics.totalPostsProcessed++;
    this.metrics.totalNewPostsAdded++;
    this.metrics.totalApiCallsMade++;

    if (this.metrics.clubStats[clubUsername]) {
      this.metrics.clubStats[clubUsername].postsProcessed++;
      this.metrics.clubStats[clubUsername].apiCallsMade++;
    }
  }

  /**
   * Records an API call (even if no useful data extracted)
   * @param {string} clubUsername - Club username
   */
  recordApiCall(clubUsername) {
    this.metrics.totalApiCallsMade++;

    if (this.metrics.clubStats[clubUsername]) {
      this.metrics.clubStats[clubUsername].apiCallsMade++;
    }
  }

  /**
   * Records a successful club completion
   * @param {string} clubUsername - Club username
   */
  recordClubSuccess(clubUsername) {
    this.metrics.clubsProcessed++;

    if (this.metrics.clubStats[clubUsername]) {
      this.metrics.clubStats[clubUsername].success = true;
    }
  }

  /**
   * Records a club failure
   * @param {string} clubUsername - Club username
   * @param {string} errorMessage - Error message
   */
  recordClubFailure(clubUsername, errorMessage) {
    this.metrics.clubsFailed++;
    this.metrics.failedClubsList.push(clubUsername);

    this.metrics.clubStats[clubUsername] = {
      ...(this.metrics.clubStats[clubUsername] || {}),
      success: false,
      error: errorMessage
    };
  }

  /**
   * Gets the current metrics
   * @returns {Object} - Current metrics object
   */
  getMetrics() {
    return { ...this.metrics };
  }

  /**
   * Gets a summary for console output
   * @returns {Object} - Summary object
   */
  getSummary() {
    return {
      totalClubs: this.metrics.totalClubs,
      clubsProcessed: this.metrics.clubsProcessed,
      clubsFailed: this.metrics.clubsFailed,
      totalPostsScraped: this.metrics.totalPostsScraped,
      totalNewPostsAdded: this.metrics.totalNewPostsAdded,
      totalDuplicatesSkipped: this.metrics.totalDuplicatesSkipped,
      totalApiCallsMade: this.metrics.totalApiCallsMade,
      failedClubs: this.metrics.failedClubsList,
      duration: this.getDuration()
    };
  }

  /**
   * Gets the duration of the scraping run
   * @returns {number|null} - Duration in milliseconds
   */
  getDuration() {
    if (!this.metrics.startTime || !this.metrics.endTime) {
      return null;
    }
    return this.metrics.endTime - this.metrics.startTime;
  }

  /**
   * Prints summary to console
   */
  printSummary() {
    const summary = this.getSummary();

    console.log(`\n--- Execution Summary ---`);
    console.log(`Total clubs processed: ${summary.clubsProcessed}/${summary.totalClubs}`);
    console.log(`Clubs failed: ${summary.clubsFailed}`);
    console.log(`Total posts scraped: ${summary.totalPostsScraped}`);
    console.log(`New posts added to spreadsheet: ${summary.totalNewPostsAdded}`);
    console.log(`Duplicates skipped: ${summary.totalDuplicatesSkipped}`);
    console.log(`API calls made: ${summary.totalApiCallsMade}`);

    if (summary.duration) {
      const seconds = Math.round(summary.duration / 1000);
      console.log(`Duration: ${seconds} seconds`);
    }
  }

  /**
   * Prints detailed statistics for a club
   * @param {string} clubUsername - Club username
   */
  printClubStats(clubUsername) {
    const stats = this.metrics.clubStats[clubUsername];
    if (!stats) return;

    console.log(`\n📊 Club @${clubUsername} Statistics:`);
    console.log(`  - Posts scraped: ${stats.postsScraped || 0}`);
    console.log(`  - New posts in date range: ${stats.newPostsFound || 0}`);
    console.log(`  - Duplicates skipped: ${stats.duplicatesSkipped || 0}`);
    if (stats.dateChecksSkipped > 0) {
      console.log(`  - Skipped before full extraction: ${stats.dateChecksSkipped} (date out of range)`);
    }
    if (!stats.success && stats.error) {
      console.log(`  - Error: ${stats.error}`);
    }
  }

  /**
   * Creates a run log object for saving
   * @param {string} startDateStr - Start date string
   * @param {string} endDateStr - End date string
   * @returns {Object} - Run log object
   */
  createRunLog(startDateStr, endDateStr) {
    const summary = this.getSummary();

    return {
      timestamp: new Date().toISOString(),
      dateRange: {
        start: startDateStr,
        end: endDateStr
      },
      totalClubs: summary.totalClubs,
      clubsProcessed: summary.clubsProcessed,
      clubsFailed: summary.clubsFailed,
      postsScraped: summary.totalPostsScraped,
      newPostsAdded: summary.totalNewPostsAdded,
      duplicatesSkipped: summary.totalDuplicatesSkipped,
      apiCallsMade: summary.totalApiCallsMade,
      failedClubs: summary.failedClubs,
      duration: summary.duration
    };
  }

  /**
   * Saves run log to file
   * @param {string} basePath - Base path for saving
   * @param {string} startDateStr - Start date string
   * @param {string} endDateStr - End date string
   * @returns {string} - Path to saved run log
   */
  saveRunLog(basePath, startDateStr, endDateStr) {
    const runLog = this.createRunLog(startDateStr, endDateStr);
    const runLogPath = path.join(basePath, 'run-log.json');
    fs.writeFileSync(runLogPath, JSON.stringify(runLog, null, 2), 'utf-8');
    console.log(`\n✓ Run log saved to ${runLogPath}`);
    return runLogPath;
  }

  /**
   * Prints final success message
   */
  printFinalSuccess() {
    const summary = this.getSummary();

    console.log('\n' + '='.repeat(60));
    console.log('✅ Process completed successfully!');
    console.log(`✅ Processed ${summary.clubsProcessed}/${summary.totalClubs} clubs`);
    console.log(`✅ Scraped ${summary.totalPostsScraped} posts, added ${summary.totalNewPostsAdded} new posts`);
    console.log(`✅ Skipped ${summary.totalDuplicatesSkipped} duplicates`);
    console.log('='.repeat(60));
  }
}

/**
 * Creates a new metrics collector
 * @returns {MetricsCollector} - New MetricsCollector instance
 */
export function createMetricsCollector() {
  return new MetricsCollector();
}
