// Main orchestrator for Instagram scraping, AI processing, and Google Sheets integration
import path from 'path';
import { fileURLToPath } from 'url';

// Module imports
import { loadConfig, getCredentialsPath, loadAccounts, loadClubs, selectClubsToProcess } from './config-manager.js';
import { createBrowserManager } from './browser-manager.js';
import { createSheetsManager } from './sheets-manager.js';
import { createOrchestrator } from './scraping-orchestrator.js';
import { createMetricsCollector } from './metrics-collector.js';
import { loginToInstagram } from './scraper.js';
import { initializeClaude } from './ai-processor.js';
import { loadProgress, saveProgress, clearProgress, createProgress } from './utils/progress.js';

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

  try {
    console.log('='.repeat(60));
    console.log('Starting Instagram Club Scraper');
    console.log('='.repeat(60));

    // Load and validate configuration
    const config = loadConfig();
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

    // Launch browser
    browserManager = await createBrowserManager({ headless: config.headlessMode });
    const context = await browserManager.createContext();
    const page = await context.newPage();

    // Initialize Google Sheets
    const credentialsPath = getCredentialsPath(__dirname);
    const sheetsManager = await createSheetsManager(credentialsPath, config.spreadsheetId);
    const existingPostUrls = await sheetsManager.loadExistingPostUrls();

    // Log into Instagram
    console.log('\n--- Logging into Instagram ---');
    await loginToInstagram(page, config.instagramUsername, config.instagramPassword);
    console.log('✓ Successfully logged into Instagram');

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

    // Initialize Claude AI client
    console.log('\n--- Initializing Claude AI ---');
    const anthropic = initializeClaude(config.anthropicApiKey);
    console.log('✓ Claude AI client initialized');

    // Create orchestrator and process clubs
    const orchestrator = createOrchestrator({
      config,
      anthropic,
      progress,
      existingPostUrls,
      metrics,
      browserManager
    });

    // Process clubs (sequential or parallel based on config)
    let results;
    if (config.parallelClubs > 1) {
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
      await sheetsManager.writeResults(results);
      await sheetsManager.sortByDate();
    } else {
      console.log('\n⚠️  No meeting data to write to spreadsheet');
    }

    // Save run log
    metrics.saveRunLog(__dirname, config.startDateStr, config.endDateStr);

    // Cleanup
    await browserManager.close();

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
  }
}

// Call main function and handle any unhandled errors
main().catch(error => {
  console.error('Unhandled error in main():', error);
  process.exit(1);
});
