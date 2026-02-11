// Dry-run mode for validating configuration without making changes
import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { authenticateSheets } from './sheets-writer.js';

/**
 * Runs a dry-run validation of the configuration
 * Tests all connections and displays what would be processed
 * @param {Object} config - Configuration object from loadConfig()
 * @param {string} basePath - Base path for file operations
 */
export async function runDryRun(config, basePath) {
  console.log('\n' + '='.repeat(60));
  console.log('🧪 DRY RUN MODE - Validating configuration');
  console.log('='.repeat(60));
  console.log('\nNo changes will be made. This is a validation-only run.\n');

  const results = {
    configValid: false,
    googleSheetsValid: false,
    claudeApiValid: false,
    clubsFound: 0,
    clubsToProcess: []
  };

  // 1. Validate configuration
  console.log('--- 1. Configuration Validation ---');
  try {
    validateConfig(config);
    console.log('✓ All required environment variables are set');
    console.log(`  - Instagram Username: ${maskString(config.instagramUsername)}`);
    console.log(`  - Anthropic API Key: ${maskString(config.anthropicApiKey)}`);
    console.log(`  - Spreadsheet ID: ${maskString(config.spreadsheetId)}`);
    console.log(`  - Date Range: ${config.startDateStr} to ${config.endDateStr}`);
    console.log(`  - Headless Mode: ${config.headlessMode}`);
    console.log(`  - Max Clubs: ${config.maxClubsToProcess}`);
    console.log(`  - Parallel Clubs: ${config.parallelClubs}`);
    console.log(`  - Resume Mode: ${config.resumeMode}`);
    results.configValid = true;
  } catch (error) {
    console.error(`✗ Configuration error: ${error.message}`);
    return results;
  }

  // 2. Test Google Sheets connection (read-only)
  console.log('\n--- 2. Google Sheets Connection Test ---');
  try {
    const credentialsPath = path.join(basePath, 'google-credentials.json');

    if (!fs.existsSync(credentialsPath)) {
      throw new Error(`Credentials file not found: ${credentialsPath}`);
    }

    console.log(`  Credentials file: ${credentialsPath} ✓`);

    const sheets = await authenticateSheets(credentialsPath);

    // Try to read spreadsheet metadata (read-only test)
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: config.spreadsheetId
    });

    const sheetTitle = spreadsheet.data.properties.title;
    const sheetCount = spreadsheet.data.sheets.length;

    console.log(`✓ Successfully connected to Google Sheets`);
    console.log(`  - Spreadsheet Title: "${sheetTitle}"`);
    console.log(`  - Number of Sheets: ${sheetCount}`);
    results.googleSheetsValid = true;
  } catch (error) {
    console.error(`✗ Google Sheets error: ${error.message}`);
    if (error.message.includes('not found')) {
      console.error('  → Check that the spreadsheet ID is correct');
    } else if (error.message.includes('permission')) {
      console.error('  → Check that the service account has access to the spreadsheet');
    }
  }

  // 3. Test Claude API (minimal call)
  console.log('\n--- 3. Claude API Connection Test ---');
  try {
    const anthropic = new Anthropic({
      apiKey: config.anthropicApiKey
    });

    // Make a minimal API call to test the key
    const message = await anthropic.messages.create({
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
      max_tokens: 10,
      messages: [
        {
          role: 'user',
          content: 'Reply with only: OK'
        }
      ]
    });

    if (message.content && message.content.length > 0) {
      console.log('✓ Claude API connection successful');
      console.log(`  - Model: ${process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514'}`);
      console.log(`  - Response: "${message.content[0].text.trim()}"`);
      results.claudeApiValid = true;
    }
  } catch (error) {
    console.error(`✗ Claude API error: ${error.message}`);
    if (error.message.includes('authentication') || error.message.includes('401')) {
      console.error('  → Check that your ANTHROPIC_API_KEY is valid');
    } else if (error.message.includes('rate limit') || error.message.includes('429')) {
      console.error('  → API key is valid but rate limited');
      results.claudeApiValid = true; // Key is valid, just rate limited
    }
  }

  // 4. Load and validate clubs
  console.log('\n--- 4. Clubs Configuration ---');
  try {
    const clubsPath = path.join(basePath, 'clubs.json');

    if (!fs.existsSync(clubsPath)) {
      throw new Error(`Clubs file not found: ${clubsPath}`);
    }

    const clubsData = JSON.parse(fs.readFileSync(clubsPath, 'utf-8'));

    if (!clubsData.clubs || !Array.isArray(clubsData.clubs)) {
      throw new Error('Invalid clubs.json format');
    }

    results.clubsFound = clubsData.clubs.length;
    console.log(`✓ Found ${results.clubsFound} club(s) in clubs.json`);

    // Determine which clubs would be processed
    if (config.testClub) {
      if (clubsData.clubs.includes(config.testClub)) {
        results.clubsToProcess = [config.testClub];
        console.log(`\n  Test mode: Would process @${config.testClub}`);
      } else {
        console.error(`\n  ✗ TEST_CLUB "${config.testClub}" not found in clubs.json`);
      }
    } else {
      // Simulate random selection
      const shuffled = [...clubsData.clubs].sort(() => Math.random() - 0.5);
      results.clubsToProcess = shuffled.slice(0, Math.min(config.maxClubsToProcess, shuffled.length));
      console.log(`\n  Would process ${results.clubsToProcess.length} club(s):`);
      results.clubsToProcess.forEach((club, i) => {
        console.log(`    ${i + 1}. @${club}`);
      });
    }
  } catch (error) {
    console.error(`✗ Clubs configuration error: ${error.message}`);
  }

  // 5. Show mock output example
  console.log('\n--- 5. Example Output Format ---');
  console.log('If a post is found, it would be processed into this format:');
  console.log(JSON.stringify({
    club_name: 'example_club',
    meeting_date: '2025-01-15',
    meeting_time: '3:30 PM',
    meeting_type: 'Club Meeting',
    location: 'Room B101',
    description: 'Weekly club meeting to discuss upcoming events',
    confidence: 0.85,
    recurrence: 'Weekly',
    post_url: 'https://www.instagram.com/p/ABC123/',
    posted_date: '2025-01-10',
    account_name: 'example_club'
  }, null, 2));

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('🧪 DRY RUN SUMMARY');
  console.log('='.repeat(60));
  console.log(`Configuration Valid:     ${results.configValid ? '✓' : '✗'}`);
  console.log(`Google Sheets Valid:     ${results.googleSheetsValid ? '✓' : '✗'}`);
  console.log(`Claude API Valid:        ${results.claudeApiValid ? '✓' : '✗'}`);
  console.log(`Clubs Found:             ${results.clubsFound}`);
  console.log(`Clubs to Process:        ${results.clubsToProcess.length}`);

  const allValid = results.configValid && results.googleSheetsValid && results.claudeApiValid;

  if (allValid) {
    console.log('\n✅ All validations passed! Ready to run without DRY_RUN=true');
  } else {
    console.log('\n⚠️  Some validations failed. Fix the issues above before running.');
  }

  console.log('='.repeat(60));

  return results;
}

/**
 * Validates required configuration values
 * @param {Object} config - Configuration object
 * @throws {Error} - If validation fails
 */
function validateConfig(config) {
  const required = [
    'instagramUsername',
    'instagramPassword',
    'anthropicApiKey',
    'spreadsheetId',
    'startDate',
    'endDate'
  ];

  for (const field of required) {
    if (!config[field]) {
      throw new Error(`Missing required configuration: ${field}`);
    }
  }

  // Validate date range
  if (config.startDate > config.endDate) {
    throw new Error('START_DATE must be <= END_DATE');
  }
}

/**
 * Masks a string for secure display (shows first 4 and last 4 characters)
 * @param {string} str - String to mask
 * @returns {string} - Masked string
 */
function maskString(str) {
  if (!str || str.length < 10) {
    return '****';
  }
  return str.substring(0, 4) + '****' + str.substring(str.length - 4);
}
