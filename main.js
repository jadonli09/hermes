// Main orchestrator for Instagram scraping, AI processing, and Google Sheets integration
import { chromium } from 'playwright';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loginToInstagram, scrapeClubPosts } from './scraper.js';
import { initializeClaude, processPostWithClaude } from './ai-processor.js';
import { authenticateSheets, updateOrAppendToSheet, sortSheetByDate, getExistingPostUrls, getExistingEvents } from './sheets-writer.js';
import { loadProgress, saveProgress, clearProgress, createProgress } from './utils/progress.js';

// Get current directory for ES6 modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config();

// Utility helper for removing single entries from arrays safely
const removeFromArray = (arr, value) => {
  if (!Array.isArray(arr)) return;
  const index = arr.indexOf(value);
  if (index !== -1) {
    arr.splice(index, 1);
  }
};

/**
 * Main execution function that orchestrates the entire process:
 * 1. Scrapes Instagram posts from club accounts
 * 2. Processes posts with Claude AI to extract meeting information
 * 3. Writes results to Google Sheets
 */
async function main() {
  let browser = null;
  let progress = null;
  
  try {
    console.log('='.repeat(60));
    console.log('Starting Instagram Club Scraper');
    console.log('='.repeat(60));
    
    // Validate environment variables
    const instagramUsername = process.env.INSTAGRAM_USERNAME;
    const instagramPassword = process.env.INSTAGRAM_PASSWORD;
    const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
    const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
    
    if (!instagramUsername || !instagramPassword) {
      throw new Error('INSTAGRAM_USERNAME and INSTAGRAM_PASSWORD must be set in .env file');
    }
    
    if (!anthropicApiKey) {
      throw new Error('ANTHROPIC_API_KEY must be set in .env file');
    }
    
    if (!spreadsheetId) {
      throw new Error('GOOGLE_SPREADSHEET_ID must be set in .env file');
    }
    
    console.log('✓ Environment variables loaded');
    
    // Load and validate date range configuration
    const startDateStr = process.env.START_DATE;
    const endDateStr = process.env.END_DATE;
    
    if (!startDateStr || !endDateStr) {
      throw new Error('START_DATE and END_DATE must be set in .env file (format: YYYY-MM-DD)');
    }
    
    // Parse dates and validate format (YYYY-MM-DD)
    const startDateMatch = startDateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const endDateMatch = endDateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    
    if (!startDateMatch) {
      throw new Error(`Invalid START_DATE format: ${startDateStr}. Expected format: YYYY-MM-DD`);
    }
    
    if (!endDateMatch) {
      throw new Error(`Invalid END_DATE format: ${endDateStr}. Expected format: YYYY-MM-DD`);
    }
    
    // Create Date objects in UTC to avoid timezone issues
    // This ensures consistent date comparisons regardless of server timezone
    const startDate = new Date(Date.UTC(
      parseInt(startDateMatch[1], 10),
      parseInt(startDateMatch[2], 10) - 1, // Month is 0-indexed
      parseInt(startDateMatch[3], 10)
    ));
    const endDate = new Date(Date.UTC(
      parseInt(endDateMatch[1], 10),
      parseInt(endDateMatch[2], 10) - 1, // Month is 0-indexed
      parseInt(endDateMatch[3], 10)
    ));
    
    // Validate dates are valid
    if (isNaN(startDate.getTime())) {
      throw new Error(`Invalid START_DATE: ${startDateStr} does not represent a valid date`);
    }
    
    if (isNaN(endDate.getTime())) {
      throw new Error(`Invalid END_DATE: ${endDateStr} does not represent a valid date`);
    }
    
    if (startDate > endDate) {
      throw new Error(`START_DATE (${startDateStr}) must be <= END_DATE (${endDateStr})`);
    }
    
    console.log(`✓ Date range configured: ${startDateStr} to ${endDateStr} (UTC)`);
    
    // Get configurable settings with defaults
    const headlessMode = process.env.HEADLESS_MODE === 'true';
    const maxClubsToProcess = parseInt(process.env.MAX_CLUBS_TO_PROCESS || '5', 10);
    const delayBetweenClubs = parseInt(process.env.DELAY_BETWEEN_CLUBS_MS || '3000', 10);
    const resumeMode = process.env.RESUME === 'true';
    const retryFailedClubs = process.env.RETRY_FAILED_CLUBS === 'true';
    
    // Load or initialize progress tracking
    if (resumeMode) {
      progress = loadProgress();
      if (progress) {
        console.log(`\n--- Resume Mode Enabled ---`);
        console.log(`Resuming from previous run: ${progress.totalClubsProcessed} clubs, ${progress.totalPostsProcessed} posts already processed`);
      } else {
        console.log('\n--- Resume Mode Enabled (No Previous Progress Found) ---');
        progress = createProgress();
      }
    } else {
      // Clear progress file if not in resume mode
      clearProgress();
      progress = createProgress();
    }
    
    // Ensure new progress properties exist regardless of resume mode
    progress.processedClubs = progress.processedClubs || [];
    progress.processedPosts = progress.processedPosts || [];
    progress.failedClubs = progress.failedClubs || [];
    
    // Launch Playwright browser (headless configurable via env var)
    console.log('\n--- Launching Browser ---');
    browser = await chromium.launch({ 
      headless: headlessMode,
      args: ['--disable-blink-features=AutomationControlled']
    });
    
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
    });
    
    const page = await context.newPage();
    console.log('✓ Browser launched');
    
    // Authenticate with Google Sheets (needed for getExistingPostUrls)
    console.log('\n--- Authenticating with Google Sheets ---');
    const credentialsPath = path.join(__dirname, 'google-credentials.json');
    
    if (!fs.existsSync(credentialsPath)) {
      throw new Error(`Google credentials file not found: ${credentialsPath}`);
    }
    
    const sheets = await authenticateSheets(credentialsPath);
    console.log('✓ Authenticated with Google Sheets');
    
    // Get existing post URLs from spreadsheet (for deduplication)
    console.log('\n--- Loading Existing Post URLs ---');
    let existingPostUrls = new Set();
    try {
      existingPostUrls = await getExistingPostUrls(sheets, spreadsheetId);
      console.log(`✓ Loaded ${existingPostUrls.size} existing post URL(s) for deduplication`);
    } catch (error) {
      console.error(`Error loading existing post URLs: ${error.message}`);
      console.warn('Continuing with empty URL set (will check all posts)');
      existingPostUrls = new Set();
    }
    
    // Log into Instagram
    console.log('\n--- Logging into Instagram ---');
    await loginToInstagram(page, instagramUsername, instagramPassword);
    console.log('✓ Successfully logged into Instagram');
    
    // Load clubs.json
    console.log('\n--- Loading Clubs Configuration ---');
    const clubsPath = path.join(__dirname, 'clubs.json');
    const clubsData = JSON.parse(fs.readFileSync(clubsPath, 'utf-8'));
    const allClubs = clubsData.clubs;
    console.log(`✓ Loaded ${allClubs.length} clubs from clubs.json`);
    
    // Randomly select clubs for processing (configurable limit)
    const processedSet = new Set(progress.processedClubs);
    const failedSet = new Set(retryFailedClubs ? [] : progress.failedClubs);
    
    let availableClubs;
    if (resumeMode) {
      availableClubs = allClubs.filter(club => !processedSet.has(club) && !failedSet.has(club));
      if (processedSet.size > 0) {
        console.log(`📝 Resume mode: skipping ${processedSet.size} club(s) already processed in previous runs`);
      }
      if (!retryFailedClubs && failedSet.size > 0) {
        console.log(`📝 Resume mode: skipping ${failedSet.size} club(s) that previously failed (set RETRY_FAILED_CLUBS=true to retry)`);
      }
      if (availableClubs.length === 0) {
        console.warn('⚠️  No remaining clubs to process - all clubs are either processed or marked as failed');
      }
    } else {
      availableClubs = [...allClubs];
    }
    
    // For testing: allow single club via TEST_CLUB env var
    const testClubEnv = process.env.TEST_CLUB;
    let testClubs;
    if (testClubEnv) {
      if (allClubs.includes(testClubEnv)) {
        testClubs = [testClubEnv];
        console.log(`🧪 Test mode: Processing only @${testClubEnv}`);
      } else {
        throw new Error(`TEST_CLUB "${testClubEnv}" not found in clubs.json`);
      }
    } else {
      const shuffled = [...availableClubs].sort(() => Math.random() - 0.5);
      const clubsToProcess = shuffled.slice(0, Math.min(maxClubsToProcess, shuffled.length));
      testClubs = clubsToProcess;
    }
    if (testClubs.length === 0) {
      throw new Error('No clubs available to process based on current filters and configuration');
    }
    console.log(`📝 Processing ${testClubs.length} club(s): ${testClubs.join(', ')}`);
    
    // Initialize Claude AI client
    console.log('\n--- Initializing Claude AI ---');
    const anthropic = initializeClaude(anthropicApiKey);
    console.log('✓ Claude AI client initialized');
    
    // Collect all results and track metrics
    const allResults = [];
    let totalPostsProcessed = 0;
    let totalPostsScraped = 0;
    let totalDuplicatesSkipped = 0;
    let totalNewPostsAdded = 0;
    let totalApiCallsMade = 0;
    let clubsFailed = 0;
    const failedClubs = [];
    
    // Process each club
    console.log('\n--- Processing Clubs ---');
    for (let i = 0; i < testClubs.length; i++) {
      const clubUsername = testClubs[i];
      console.log(`\n[${i + 1}/${testClubs.length}] Processing club: @${clubUsername}`);
      
      try {
        // Scrape posts from club with date range filtering and URL deduplication
        const scrapeResult = await scrapeClubPosts(page, clubUsername, startDate, endDate, existingPostUrls);
        
        const { newPosts, stoppedAt, totalScraped, duplicatesSkipped, dateChecksSkipped = 0 } = scrapeResult;
        
        // Successful scrape means club should no longer be considered failed
        if (progress.failedClubs.includes(clubUsername)) {
          removeFromArray(progress.failedClubs, clubUsername);
        }
        
        // Update metrics
        totalPostsScraped += totalScraped;
        totalDuplicatesSkipped += duplicatesSkipped;
        
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
          if (!progress.processedClubs.includes(clubUsername)) {
            progress.processedClubs.push(clubUsername);
            progress.totalClubsProcessed++;
            progress.lastProcessedClub = clubUsername;
          }
          saveProgress(progress);
          continue;
        }
        
        // Mark club as processed after successful scraping
        if (!progress.processedClubs.includes(clubUsername)) {
          progress.processedClubs.push(clubUsername);
          progress.totalClubsProcessed++;
          progress.lastProcessedClub = clubUsername;
        }
        saveProgress(progress);
        
        // Process each new post with Claude AI (only newPosts array)
        console.log(`  Processing ${newPosts.length} new post(s) with Claude AI...`);
        for (let j = 0; j < newPosts.length; j++) {
          const post = newPosts[j];
          console.log(`  Processing post ${j + 1}/${newPosts.length}...`);
          
          try {
            // Skip post if already processed (in resume mode)
            if (resumeMode && progress.processedPosts.includes(post.postUrl)) {
              console.log(`  ⏭️  Skipping already processed post: ${post.postUrl}`);
              continue;
            }
            
            // Process post with Claude (pass page for image fetching)
            const result = await processPostWithClaude(anthropic, post, page);
            totalApiCallsMade++;
            
            // Only add results that have some useful data (not all null)
            if (result.meeting_date || result.meeting_time || result.meeting_type || result.location) {
              allResults.push(result);
              totalPostsProcessed++;
              totalNewPostsAdded++;
              progress.totalPostsProcessed++;
              
              // Mark post as processed
              if (!progress.processedPosts.includes(post.postUrl)) {
                progress.processedPosts.push(post.postUrl);
              }
              
              // Save progress after each successful post
              saveProgress(progress);
              
              console.log(`  ✓ Extracted meeting info: ${result.meeting_date || 'N/A'} ${result.meeting_time || 'N/A'}`);
            } else {
              console.log(`  ⚠️  No meeting information extracted from post`);
            }
          } catch (error) {
            console.error(`  ✗ Error processing post: ${error.message}`);
            // Continue with next post
          }
        }
        
      } catch (error) {
        clubsFailed++;
        failedClubs.push(clubUsername);
        if (!progress.failedClubs.includes(clubUsername)) {
          progress.failedClubs.push(clubUsername);
        }
        saveProgress(progress);
        
        // Check if error is related to Instagram blocking
        if (error.message.includes('blocking') || error.message.includes('challenge') || 
            error.message.includes('rate limit') || error.message.includes('restricted')) {
          console.error(`✗ Instagram blocking detected for @${clubUsername}: ${error.message}`);
          console.error('  → Consider waiting before retrying or checking account status');
        } else {
          console.error(`✗ Error processing club @${clubUsername}: ${error.message}`);
        }
        // Continue with next club
      }
      
      // Add configurable delay between clubs
      if (i < testClubs.length - 1) {
        console.log(`Waiting ${delayBetweenClubs / 1000} seconds before next club...`);
        await page.waitForTimeout(delayBetweenClubs);
      }
    }
    
    // Generate summary statistics
    const clubsProcessed = testClubs.length - clubsFailed;
    const totalClubs = testClubs.length;
    
    console.log(`\n--- Execution Summary ---`);
    console.log(`Total clubs processed: ${clubsProcessed}/${totalClubs}`);
    console.log(`Clubs failed: ${clubsFailed}`);
    console.log(`Total posts scraped: ${totalPostsScraped}`);
    console.log(`New posts added to spreadsheet: ${totalNewPostsAdded}`);
    console.log(`Duplicates skipped: ${totalDuplicatesSkipped}`);
    console.log(`API calls made: ${totalApiCallsMade} (should equal ${totalNewPostsAdded})`);
    console.log(`Total meetings extracted: ${allResults.length}`);
    
    // Write results to spreadsheet
    if (allResults.length > 0) {
      console.log('\n--- Writing to Google Sheets ---');
      
      // Load existing events for update comparison
      let existingEvents = null;
      try {
        existingEvents = await getExistingEvents(sheets, spreadsheetId);
        const totalEvents = Array.from(existingEvents.values()).reduce((sum, arr) => sum + arr.length, 0);
        console.log(`✓ Loaded ${totalEvents} existing event(s) for update comparison (${existingEvents.size} unique post URLs)`);
      } catch (error) {
        console.warn(`Warning: Could not load existing events: ${error.message}`);
        console.warn('Continuing with update/append (will treat all as new)');
      }
      
      const stats = await updateOrAppendToSheet(sheets, spreadsheetId, allResults, existingEvents, false);
      console.log('✓ Successfully wrote data to spreadsheet');
      console.log(`  - Updated: ${stats.updated} row(s)`);
      console.log(`  - Appended: ${stats.appended} row(s)`);
      console.log(`  - Skipped: ${stats.skipped} row(s) (no changes)`);
      if (stats.duplicatesRemoved > 0) {
        console.log(`  - Duplicates removed: ${stats.duplicatesRemoved} row(s)`);
      }
      
      // Sort spreadsheet by date
      console.log('\n--- Sorting Spreadsheet ---');
      await sortSheetByDate(sheets, spreadsheetId);
      console.log('✓ Successfully sorted spreadsheet by date');
    } else {
      console.log('\n⚠️  No meeting data to write to spreadsheet');
    }
    
    // Create run-log.json
    const runLog = {
      timestamp: new Date().toISOString(),
      dateRange: {
        start: startDateStr,
        end: endDateStr
      },
      totalClubs: totalClubs,
      clubsProcessed: clubsProcessed,
      clubsFailed: clubsFailed,
      postsScraped: totalPostsScraped,
      newPostsAdded: totalNewPostsAdded,
      duplicatesSkipped: totalDuplicatesSkipped,
      apiCallsMade: totalApiCallsMade,
      failedClubs: failedClubs
    };
    
    const runLogPath = path.join(__dirname, 'run-log.json');
    fs.writeFileSync(runLogPath, JSON.stringify(runLog, null, 2), 'utf-8');
    console.log(`\n✓ Run log saved to ${runLogPath}`);
    
    // Close browser
    console.log('\n--- Cleaning Up ---');
    await browser.close();
    console.log('✓ Browser closed');
    
    console.log('\n' + '='.repeat(60));
    console.log('✅ Process completed successfully!');
    console.log(`✅ Processed ${clubsProcessed}/${totalClubs} clubs`);
    console.log(`✅ Scraped ${totalPostsScraped} posts, added ${totalNewPostsAdded} new posts`);
    console.log(`✅ Extracted ${allResults.length} meetings`);
    console.log(`✅ Skipped ${totalDuplicatesSkipped} duplicates`);
    console.log('='.repeat(60));
    
  } catch (error) {
    console.error('\n' + '='.repeat(60));
    console.error('❌ Error during execution:');
    console.error(error.message);
    console.error('='.repeat(60));
    
    // Log error details
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
    if (browser) {
      try {
        await browser.close();
        console.log('\n✓ Browser closed after error');
      } catch (closeError) {
        console.error('Error closing browser:', closeError.message);
      }
    }
    
    // Exit with error code
    process.exit(1);
  }
}

// Call main function and handle any unhandled errors
main().catch(error => {
  console.error('Unhandled error in main():', error);
  process.exit(1);
});
