// Dry-run mode for validating configuration without making changes
import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { authenticateSheets } from './sheets-writer.js';
import { getConfiguredModels, modelParams } from './ai-processor.js';
import { loadAccounts } from './config-manager.js';

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
    console.log(`  - Scraper Backend: ${config.scraperBackend}`);

    if (config.scraperBackend === 'apify') {
      console.log(`  - Apify Token: ${maskString(config.apifyToken)}`);
      console.log(`  - Apify Actor: ${config.apifyActorId}`);
      console.log(`  - Apify Cost Ceiling: $${config.apifyMaxChargeUsd}/run`);
    } else {
      console.log(`  - Instagram Username: ${maskString(config.instagramUsername)}`);
      console.log(`  - Headless Mode: ${config.headlessMode}`);
    }

    console.log(`  - Anthropic API Key: ${maskString(config.anthropicApiKey)}`);
    console.log(`  - Spreadsheet ID: ${maskString(config.spreadsheetId)}`);
    console.log(`  - Date Range: ${config.startDateStr} to ${config.endDateStr}`);
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

    // Test every model the run can actually select - a retired ID on the Haiku path
    // would otherwise only surface mid-run, on whichever posts happen to route there
    const models = getConfiguredModels();
    const checks = [];

    for (const [label, modelId] of Object.entries(models)) {
      const message = await anthropic.messages.create({
        model: modelId,
        max_tokens: 32,
        ...modelParams(modelId),
        messages: [
          {
            role: 'user',
            content: 'Reply with only: OK'
          }
        ]
      });

      const text = message.content?.[0]?.text?.trim() || '';
      console.log(`✓ ${label}: ${modelId} → "${text}"`);
      checks.push(text.length > 0);
    }

    if (checks.length > 0 && checks.every(Boolean)) {
      console.log('✓ Claude API connection successful');
      results.claudeApiValid = true;
    }
  } catch (error) {
    console.error(`✗ Claude API error: ${error.message}`);
    if (error.message.includes('authentication') || error.message.includes('401')) {
      console.error('  → Check that your ANTHROPIC_API_KEY is valid');
    } else if (error.message.includes('rate limit') || error.message.includes('429')) {
      console.error('  → API key is valid but rate limited');
      results.claudeApiValid = true; // Key is valid, just rate limited
    } else if (error.message.includes('404') || error.message.includes('not_found')) {
      console.error('  → Model ID is retired or misspelled. Check CLAUDE_MODEL / HAIKU_MODEL');
      console.error('  → Current model IDs: https://platform.claude.com/docs/en/about-claude/model-deprecations');
    }
  }

  // 4. Load and validate accounts
  console.log('\n--- 4. Accounts Configuration ---');
  try {
    // main.js loads through loadAccounts, so the dry run must too. Reading
    // clubs.json directly reported 80 accounts while the real run processed 85,
    // which makes the dry run worse than useless as a pre-flight check.
    const { accounts, categories } = loadAccounts(basePath, config.category);

    results.clubsFound = accounts.length;
    console.log(`✓ Found ${results.clubsFound} enabled account(s) in accounts.json`);

    const summary = Object.entries(categories)
      .map(([name, cat]) => `${name}: ${cat.accounts?.length || 0}${cat.enabled === false ? ' (disabled)' : ''}`);
    console.log(`  Categories: ${summary.join(', ')}`);

    if (config.category) {
      console.log(`  Filtering to category: ${config.category}`);
    }

    // Determine which accounts would be processed
    if (config.testClub) {
      if (accounts.includes(config.testClub)) {
        results.clubsToProcess = [config.testClub];
        console.log(`\n  Test mode: Would process @${config.testClub}`);
      } else {
        console.error(`\n  ✗ TEST_CLUB "${config.testClub}" not found in accounts.json`);
      }
    } else {
      results.clubsToProcess = accounts.slice(0, Math.min(config.maxClubsToProcess, accounts.length));
      console.log(`\n  Would process ${results.clubsToProcess.length} account(s):`);
      results.clubsToProcess.forEach((club, i) => {
        console.log(`    ${i + 1}. @${club}`);
      });
    }
  } catch (error) {
    console.error(`✗ Accounts configuration error: ${error.message}`);
  }

  // 5. Show mock output example
  console.log('\n--- 5. Example Output Format ---');
  console.log('If a post is found, it would be processed into this format:');
  console.log(JSON.stringify({
    club_name: 'example_club',
    event_date: '2026-01-15',
    event_time: '3:30 PM',
    event_type: 'Club Meeting',
    location: 'Room B101',
    description: 'Weekly club meeting to discuss upcoming events',
    confidence: 0.85,
    post_url: 'https://www.instagram.com/p/ABC123/',
    posted_date: '2026-01-10',
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
    'anthropicApiKey',
    'spreadsheetId',
    'startDate',
    'endDate'
  ];

  // Backend-specific credentials: the apify backend deliberately has no
  // Instagram account, so requiring one here would be wrong.
  if (config.scraperBackend === 'playwright') {
    required.push('instagramUsername', 'instagramPassword');
  } else if (config.scraperBackend === 'apify') {
    required.push('apifyToken');
  }

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
