// Scraping orchestrator for coordinating multi-club processing
import { processClub, isBlockingError } from './club-processor.js';
import { saveProgress } from './utils/progress.js';
import { emit } from './utils/progress-events.js';

/**
 * Orchestrates the scraping of multiple clubs
 * Supports both sequential and parallel processing
 */
export class ScrapingOrchestrator {
  constructor(options = {}) {
    this.config = options.config || {};
    this.anthropic = options.anthropic;
    this.progress = options.progress;
    this.existingPostUrls = options.existingPostUrls || new Set();
    this.metrics = options.metrics;
    this.browserManager = options.browserManager;
    this.scrapeClubPosts = options.scrapeClubPosts;

    // The inter-club delay exists to pace requests to Instagram. Backends that
    // prefetch (Apify) have already made every network call before this loop
    // starts, so the delay would just be dead sleep - ~4 minutes across 85
    // accounts, every run.
    this.needsPacing = options.needsPacing !== false;

    // All results collected across all clubs
    this.allResults = [];

    // Circuit breaker state
    this.consecutiveFailures = 0;
    this.circuitOpen = false;
    this.maxConsecutiveFailures = 5;
    this.circuitCooldownMs = 60000;
  }

  /**
   * Processes clubs sequentially (one at a time)
   * @param {Array<string>} clubs - Array of club usernames to process
   * @param {Page} page - Playwright page object
   * @returns {Promise<Array>} - Array of all results
   */
  async processSequentially(clubs, page) {
    console.log('\n--- Processing Clubs (Sequential) ---');

    const { startDate, endDate, delayBetweenClubs = 3000, resumeMode = false } = this.config;

    for (let i = 0; i < clubs.length; i++) {
      const clubUsername = clubs[i];
      console.log(`\n[${i + 1}/${clubs.length}] Processing club: @${clubUsername}`);

      // Check circuit breaker
      if (this.circuitOpen) {
        console.log(`⚠️  Circuit breaker open - waiting ${this.circuitCooldownMs / 1000}s before continuing...`);
        await new Promise(resolve => setTimeout(resolve, this.circuitCooldownMs));
        this.circuitOpen = false;
        this.consecutiveFailures = 0;
      }

      emit('club:start', { index: i + 1, total: clubs.length, account: clubUsername });
      const clubStartedAt = Date.now();

      const result = await processClub({
        page,
        clubUsername,
        startDate,
        endDate,
        existingPostUrls: this.existingPostUrls,
        anthropic: this.anthropic,
        progress: this.progress,
        resumeMode,
        metrics: this.metrics,
        scrapeClubPosts: this.scrapeClubPosts
      });

      if (result.success) {
        emit('club:done', {
          index: i + 1,
          total: clubs.length,
          account: clubUsername,
          postsFound: result.stats?.totalScraped ?? 0,
          eventsExtracted: result.results?.length ?? 0,
          durationMs: Date.now() - clubStartedAt
        });
      } else {
        emit('club:error', {
          index: i + 1,
          total: clubs.length,
          account: clubUsername,
          message: result.error || 'unknown error'
        });
      }

      if (result.success) {
        this.consecutiveFailures = 0;
        this.allResults.push(...result.results);
      } else {
        this.consecutiveFailures++;

        // Check if circuit breaker should open
        if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
          console.error(`⚠️  ${this.maxConsecutiveFailures} consecutive failures - opening circuit breaker`);
          this.circuitOpen = true;
        }

        // Check for blocking errors
        if (isBlockingError(result.error)) {
          console.warn('⚠️  Blocking detected - consider stopping and waiting');
        }
      }

      // Add delay between clubs (except for the last one)
      if (this.needsPacing && i < clubs.length - 1) {
        console.log(`Waiting ${delayBetweenClubs / 1000} seconds before next club...`);
        await new Promise(resolve => setTimeout(resolve, delayBetweenClubs));
      }
    }

    return this.allResults;
  }

  /**
   * Processes clubs in parallel batches
   * @param {Array<string>} clubs - Array of club usernames to process
   * @param {Object} sharedStorageState - Shared login cookies
   * @returns {Promise<Array>} - Array of all results
   */
  async processParallel(clubs, sharedStorageState) {
    const parallelCount = this.config.parallelClubs || 1;

    if (parallelCount <= 1) {
      throw new Error('Parallel processing requires parallelClubs > 1. Use processSequentially for single worker.');
    }

    console.log(`\n--- Processing Clubs (Parallel: ${parallelCount} workers) ---`);

    const { startDate, endDate, delayBetweenClubs = 3000, resumeMode = false } = this.config;
    const staggerDelay = 2000; // 2s between worker starts

    // Process clubs in batches
    const batches = [];
    for (let i = 0; i < clubs.length; i += parallelCount) {
      batches.push(clubs.slice(i, i + parallelCount));
    }

    console.log(`Processing ${clubs.length} clubs in ${batches.length} batch(es)`);

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      console.log(`\n[Batch ${batchIndex + 1}/${batches.length}] Processing ${batch.length} club(s)`);

      // Check circuit breaker before batch
      if (this.circuitOpen) {
        console.log(`⚠️  Circuit breaker open - waiting ${this.circuitCooldownMs / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, this.circuitCooldownMs));
        this.circuitOpen = false;
        this.consecutiveFailures = 0;
      }

      // Create parallel contexts for this batch
      const workers = await this.browserManager.createParallelContexts(
        batch.length,
        sharedStorageState,
        staggerDelay
      );

      try {
        // Process batch in parallel
        const batchPromises = batch.map((clubUsername, workerIndex) =>
          this.processClubWithWorker(
            workers[workerIndex],
            clubUsername,
            workerIndex
          )
        );

        const batchResults = await Promise.allSettled(batchPromises);

        // Collect results and track failures
        let batchFailures = 0;
        for (const result of batchResults) {
          if (result.status === 'fulfilled' && result.value.success) {
            this.allResults.push(...result.value.results);
            this.consecutiveFailures = 0;
          } else {
            batchFailures++;
            this.consecutiveFailures++;
          }
        }

        // Check circuit breaker
        if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
          console.error(`⚠️  ${this.maxConsecutiveFailures} consecutive failures - opening circuit breaker`);
          this.circuitOpen = true;
        }

      } finally {
        // Close batch contexts to free resources
        for (const worker of workers) {
          await this.browserManager.closeContext(worker.context);
        }
      }

      // Add delay between batches (except for the last one)
      if (batchIndex < batches.length - 1) {
        console.log(`Waiting ${delayBetweenClubs / 1000}s before next batch...`);
        await new Promise(resolve => setTimeout(resolve, delayBetweenClubs));
      }
    }

    return this.allResults;
  }

  /**
   * Process a club with a specific worker
   * @private
   */
  async processClubWithWorker(worker, clubUsername, workerIndex) {
    const { startDate, endDate, resumeMode = false } = this.config;

    console.log(`  Worker ${workerIndex + 1}: Processing @${clubUsername}`);

    return await processClub({
      page: worker.page,
      clubUsername,
      startDate,
      endDate,
      existingPostUrls: this.existingPostUrls,
      anthropic: this.anthropic,
      progress: this.progress,
      resumeMode,
      metrics: this.metrics,
      scrapeClubPosts: this.scrapeClubPosts
    });
  }

  /**
   * Gets all collected results
   * @returns {Array} - All processing results
   */
  getResults() {
    return this.allResults;
  }

  /**
   * Gets the count of results
   * @returns {number} - Number of results
   */
  getResultCount() {
    return this.allResults.length;
  }

  /**
   * Resets the orchestrator state
   */
  reset() {
    this.allResults = [];
    this.consecutiveFailures = 0;
    this.circuitOpen = false;
  }
}

/**
 * Creates a scraping orchestrator
 * @param {Object} options - Orchestrator options
 * @returns {ScrapingOrchestrator} - New orchestrator instance
 */
export function createOrchestrator(options) {
  return new ScrapingOrchestrator(options);
}
