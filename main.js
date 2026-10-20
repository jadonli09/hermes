// Main orchestrator for Instagram scraping, AI processing, and Google Sheets integration
import { recordPipelineActivity } from './automation/pipeline-activity.js';
import path from 'path';
import { assertNoPendingAppend } from './automation/sheets-append.js';
import { lock } from './automation/state.js';
import { refreshScope, recordRefreshActivity } from './automation/refresh-activity.js';
import { fileURLToPath } from 'url';

// Module imports
import { loadConfig, getCredentialsPath, loadAccounts, loadClubs, selectClubsToProcess } from './config-manager.js';
import { createBrowserManager } from './browser-manager.js';
import { createScraperBackend } from './scrapers/index.js';
import { createSheetsManager } from './sheets-manager.js';
import { createOrchestrator } from './scraping-orchestrator.js';
import { createMetricsCollector } from './metrics-collector.js';
import { loginToInstagram } from './scraper.js';
import { initializeClaude } from './ai-processor.js';
import { loadProgress, saveProgress, clearProgress, createProgress } from './utils/progress.js';
import { emit } from './utils/progress-events.js';

// Get current directory for ES6 modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Main execution function that orchestrates the entire process:
 * 1. Scrapes Instagram posts from club accounts
 * 2. Processes posts with Claude AI to extract meeting information
 * 3. Writes results to Google Sheets
 */
async function main() {
  let browserManager = null;
  let progress = null;
  let release = null;
  const startedAt = new Date().toISOString();
  const scope = refreshScope(__dirname);

  try {
    console.log('='.repeat(60));
    console.log('Starting Instagram Club Scraper');
    console.log('='.repeat(60));

    release = lock(path.join(__dirname, '.hermes/pipeline.lock'));
    process.once('exit', () => { if (release) { release(); release = null; } });

    // Load and validate configuration
    const config = loadConfig();
    assertNoPendingAppend();
    console.log('✓ Environment variables loaded');
    console.log(`✓ Scraping posts from: ${config.startDateStr} onwards`);

    // Log optimization settings
    console.log('\n--- Performance Optimizations ---');
    console.log(`✓ Date-first filtering: ${config.enableDateFirstFiltering ? 'ENABLED' : 'disabled'}`);
    console.log(`✓ Max carousel images: ${config.maxCarouselImages}`);
    console.log(`✓ Parallel clubs: ${config.parallelClubs}`);
    console.log(`✓ Model selection: ${config.forceModel || 'auto (Haiku for simple posts, Sonnet for complex)'}`);
    console.log('---');

    // Check for dry run mode
    if (config.dryRun) {
      const { runDryRun } = await import('./dry-run-mode.js');
      await runDryRun(config, __dirname);
      return;
    }

    // Initialize progress tracking
    if (config.resumeMode) {
      progress = loadProgress();
      if (progress) {
        console.log(`\n--- Resume Mode Enabled ---`);
        console.log(`Resuming from previous run: ${progress.totalClubsProcessed} clubs, ${progress.totalPostsProcessed} posts already processed`);
      } else {
        console.log('\n--- Resume Mode Enabled (No Previous Progress Found) ---');
        progress = createProgress();
      }
    } else {
      clearProgress();
      progress = createProgress();
    }

    // Ensure progress properties exist
    progress.processedClubs = progress.processedClubs || [];
    progress.processedPosts = progress.processedPosts || [];
    progress.failedClubs = progress.failedClubs || [];

    // Initialize metrics collector
    const metrics = createMetricsCollector();
    metrics.start();

    // Select the scraper backend. The Apify backend needs no browser and no
    // Instagram login, so skip both entirely rather than paying for a browser
    // launch and a fresh login on every scheduled run.
    const scraperBackend = createScraperBackend(config);
    console.log(`\n--- Scraper backend: ${scraperBackend.name} ---`);

    let page = null;
    let context = null;

    if (scraperBackend.requiresBrowser) {
      browserManager = await createBrowserManager({ headless: config.headlessMode });
      context = await browserManager.createContext();
      page = await context.newPage();
    }

    // Initialize Google Sheets
    const credentialsPath = getCredentialsPath(__dirname);
    const sheetsManager = await createSheetsManager(credentialsPath, config.spreadsheetId);
    const existingPostUrls = await sheetsManager.loadExistingPostUrls();

    if (scraperBackend.requiresBrowser) {
      console.log('\n--- Logging into Instagram ---');
      await loginToInstagram(page, config.instagramUsername, config.instagramPassword);
      console.log('✓ Successfully logged into Instagram');
    }

    // Load and select accounts
    console.log('\n--- Loading Accounts Configuration ---');
    const { accounts: allAccounts, categories } = loadAccounts(__dirname, config.category);

    // Show category summary
    const enabledCategories = Object.entries(categories)
      .filter(([_, cat]) => cat.enabled !== false)
      .map(([name, cat]) => `${name}: ${cat.accounts?.length || 0}`);
    console.log(`✓ Categories: ${enabledCategories.join(', ')}`);

    if (config.category) {
      console.log(`✓ Filtering to category: ${config.category}`);
    }
    console.log(`✓ Total accounts to consider: ${allAccounts.length}`);

    // Use allAccounts as allClubs for compatibility
    const allClubs = allAccounts;

    const clubsToProcess = selectClubsToProcess(allClubs, config, progress);
    metrics.setTotalClubs(clubsToProcess.length);

    emit('run:config', {
      accounts: clubsToProcess.length,
      startDate: config.startDateStr,
      endDate: config.endDateStr,
      backend: scraperBackend.name
    });

    // Initialize Claude AI client
    console.log('\n--- Initializing Claude AI ---');
    const anthropic = initializeClaude(config.anthropicApiKey);
    console.log('✓ Claude AI client initialized');

    // Apify returns every account in one actor run, so fetch up front and let the
    // per-club loop read from that. Keeps the orchestrator identical either way.
    if (scraperBackend.prefetch) {
      emit('phase', { name: 'prefetch' });
      await scraperBackend.prefetch(clubsToProcess, config.startDate);
    }

    // Create orchestrator and process clubs
    const orchestrator = createOrchestrator({
      config,
      anthropic,
      progress,
      existingPostUrls,
      metrics,
      browserManager,
      scrapeClubPosts: scraperBackend.scrapeClubPosts,
      needsPacing: scraperBackend.requiresBrowser
    });

    // Process clubs (sequential or parallel based on config).
    // Parallel workers exist to run multiple browsers; with no browser there is
    // nothing to parallelize - the network fetch already happened in prefetch.
    emit('phase', { name: 'process' });

    let results;
    if (config.parallelClubs > 1 && scraperBackend.requiresBrowser) {
      // Get storage state for sharing login cookies
      const storageState = await browserManager.getStorageState(context);
      results = await orchestrator.processParallel(clubsToProcess, storageState);
    } else {
      results = await orchestrator.processSequentially(clubsToProcess, page);
    }

    // End metrics timing
    metrics.end();
    metrics.printSummary();

    // Write results to spreadsheet
    if (results.length > 0) {
      emit('phase', { name: 'write' });
      const stats = await sheetsManager.writeResults(results);
      emit('sheet:write', {
        updated: stats?.updated ?? 0,
        appended: stats?.appended ?? 0,
        skipped: stats?.skipped ?? 0
      });
      await sheetsManager.sortByDate();
    } else {
      console.log('\n⚠️  No meeting data to write to spreadsheet');
      emit('sheet:write', { updated: 0, appended: 0, skipped: 0 });
    }

    // Save run log (before the health check, so a failed run still leaves diagnostics)
    metrics.saveRunLog(__dirname, config.startDateStr, config.endDateStr);
    emit('summary', { summary: metrics.getSummary() });

    // Cleanup
    if (browserManager) {
      await browserManager.close();
      browserManager = null;
    }

    // Fail loudly if we spent API calls and got nothing back - otherwise a broken
    // extraction pipeline is indistinguishable from "no new posts this week"
    const health = metrics.checkRunHealth();
    if (!health.healthy) {
      if (health.fatal && process.env.ALLOW_EMPTY_EXTRACTION !== 'true') {
        console.error('\n' + '='.repeat(60));
        console.error('❌ Run produced no data:');
        console.error(health.message);
        console.error('='.repeat(60));
        process.exit(1);
      }
      console.warn('\n' + '='.repeat(60));
      console.warn('⚠️  Degraded run:');
      console.warn(health.message);
      console.warn('='.repeat(60));
    }

    const summary = metrics.getSummary();
    if (process.env.HERMES_STRICT_REFRESH === 'true' &&
        (summary.clubsFailed > 0 || summary.totalExtractionErrors > 0)) {
      throw new Error('Partial refresh failure; refusing scheduled publication');
    }
    scraperBackend.acknowledge?.();
    recordRefreshActivity(__dirname, { startedAt, scope, summary,
      fullCoverage: (scraperBackend.name !== 'apify' || scraperBackend.getCoverage?.()?.complete === true) && !config.category && clubsToProcess.length === allAccounts.length });

    if (!process.env.HERMES_APIFY_STATE) recordPipelineActivity(__dirname, { startedAt, scope, summary,
      allAccountsProcessed: !config.category && clubsToProcess.length === allAccounts.length });

    // Print final success message
    metrics.printFinalSuccess();

  } catch (error) {
    console.error('\n' + '='.repeat(60));
    console.error('❌ Error during execution:');
    console.error(error.message);
    console.error('='.repeat(60));

    if (error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }

    // Save progress before exiting on error
    if (progress) {
      console.log('\n--- Saving Progress Before Exit ---');
      saveProgress(progress);
      console.log('✓ Progress saved - you can resume with RESUME=true');
    }

    // Ensure browser is closed on error
    if (browserManager) {
      try {
        await browserManager.close();
      } catch (closeError) {
        console.error('Error closing browser:', closeError.message);
      }
    }

    process.exit(1);
  } finally {
    if (release) { release(); release = null; }
  }
}

// Call main function and handle any unhandled errors
main().catch(error => {
  console.error('Unhandled error in main():', error);
  process.exit(1);
});
