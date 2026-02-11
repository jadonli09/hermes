// Configuration manager for loading and validating environment variables
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

// Load environment variables
dotenv.config();

/**
 * Validates required environment variables and returns configuration object
 * @returns {Object} - Configuration object with all required settings
 * @throws {Error} - If required environment variables are missing or invalid
 */
export function loadConfig() {
  // Validate required credentials
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

  // Validate date configuration
  const startDateStr = process.env.START_DATE;

  if (!startDateStr) {
    throw new Error('START_DATE must be set in .env file (format: YYYY-MM-DD)');
  }

  // END_DATE is optional - defaults to 1 year from now if not provided
  const defaultEndDate = new Date();
  defaultEndDate.setFullYear(defaultEndDate.getFullYear() + 1);
  const endDateStr = process.env.END_DATE || defaultEndDate.toISOString().split('T')[0];

  // Parse and validate date format (YYYY-MM-DD)
  const { startDate, endDate } = parseDateRange(startDateStr, endDateStr);

  // Get configurable settings with defaults
  const config = {
    // Credentials
    instagramUsername,
    instagramPassword,
    anthropicApiKey,
    spreadsheetId,

    // Date range
    startDate,
    endDate,
    startDateStr,
    endDateStr,

    // Browser settings
    headlessMode: process.env.HEADLESS_MODE === 'true',

    // Processing settings
    maxClubsToProcess: parseInt(process.env.MAX_CLUBS_TO_PROCESS || '5', 10),
    delayBetweenClubs: parseInt(process.env.DELAY_BETWEEN_CLUBS_MS || '3000', 10),
    parallelClubs: parseInt(process.env.PARALLEL_CLUBS || '1', 10),

    // Resume/retry settings
    resumeMode: process.env.RESUME === 'true',
    retryFailedClubs: process.env.RETRY_FAILED_CLUBS === 'true',

    // Test mode
    testClub: process.env.TEST_CLUB || null,

    // Dry run mode
    dryRun: process.env.DRY_RUN === 'true',

    // Performance optimizations
    enableDateFirstFiltering: process.env.ENABLE_DATE_FIRST_FILTERING !== 'false', // Default: true
    maxCarouselImages: parseInt(process.env.MAX_CAROUSEL_IMAGES || '3', 10),
    forceModel: process.env.FORCE_MODEL || null, // 'haiku' or 'sonnet' to override model selection

    // Category filter (null = all enabled categories)
    category: process.env.CATEGORY || null
  };

  return config;
}

/**
 * Parses and validates date range strings
 * @param {string} startDateStr - Start date string (YYYY-MM-DD)
 * @param {string} endDateStr - End date string (YYYY-MM-DD)
 * @returns {Object} - Object with startDate and endDate as Date objects
 * @throws {Error} - If dates are invalid or range is invalid
 */
export function parseDateRange(startDateStr, endDateStr) {
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

  return { startDate, endDate };
}

/**
 * Validates that credentials file exists
 * @param {string} basePath - Base path to check for credentials
 * @returns {string} - Full path to credentials file
 * @throws {Error} - If credentials file not found
 */
export function getCredentialsPath(basePath) {
  const credentialsPath = path.join(basePath, 'google-credentials.json');

  if (!fs.existsSync(credentialsPath)) {
    throw new Error(`Google credentials file not found: ${credentialsPath}`);
  }

  return credentialsPath;
}

/**
 * Loads accounts configuration from accounts.json (or legacy clubs.json)
 * Supports both new categorized format and legacy flat format
 * @param {string} basePath - Base path to check for config files
 * @param {string|null} category - Optional category to filter (null = all enabled)
 * @returns {Object} - { accounts: Array<string>, categories: Object }
 * @throws {Error} - If config file not found or invalid
 */
export function loadAccounts(basePath, category = null) {
  // Try new accounts.json first
  const accountsPath = path.join(basePath, 'accounts.json');
  const legacyPath = path.join(basePath, 'clubs.json');

  let configPath;
  let isLegacy = false;

  if (fs.existsSync(accountsPath)) {
    configPath = accountsPath;
  } else if (fs.existsSync(legacyPath)) {
    configPath = legacyPath;
    isLegacy = true;
    console.log('📝 Using legacy clubs.json (consider migrating to accounts.json)');
  } else {
    throw new Error('No accounts.json or clubs.json found');
  }

  const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  // Handle legacy format
  if (isLegacy || configData.clubs) {
    const clubs = configData.clubs || [];
    return {
      accounts: clubs,
      categories: { clubs: { accounts: clubs, enabled: true } },
      allAccounts: clubs
    };
  }

  // Handle new categorized format
  if (!configData.categories) {
    throw new Error('Invalid accounts.json: missing "categories" object');
  }

  const result = {
    accounts: [],
    categories: configData.categories,
    allAccounts: []
  };

  // Collect all accounts from all categories
  for (const [catName, catData] of Object.entries(configData.categories)) {
    if (!catData.accounts || !Array.isArray(catData.accounts)) continue;

    // Add to allAccounts
    result.allAccounts.push(...catData.accounts);

    // Filter by category if specified
    if (category) {
      if (catName === category && catData.enabled !== false) {
        result.accounts.push(...catData.accounts);
      }
    } else {
      // Include all enabled categories
      if (catData.enabled !== false) {
        result.accounts.push(...catData.accounts);
      }
    }
  }

  return result;
}

/**
 * Legacy function - loads clubs from clubs.json or accounts.json
 * @deprecated Use loadAccounts instead
 */
export function loadClubs(basePath) {
  const { accounts } = loadAccounts(basePath);
  return accounts;
}

/**
 * Selects clubs to process based on configuration and progress
 * @param {Array<string>} allClubs - All available clubs
 * @param {Object} config - Configuration object
 * @param {Object} progress - Progress tracking object
 * @returns {Array<string>} - Array of clubs to process
 */
export function selectClubsToProcess(allClubs, config, progress) {
  const { resumeMode, retryFailedClubs, testClub, maxClubsToProcess } = config;

  // Test mode: single club
  if (testClub) {
    if (!allClubs.includes(testClub)) {
      throw new Error(`TEST_CLUB "${testClub}" not found in clubs.json`);
    }
    console.log(`🧪 Test mode: Processing only @${testClub}`);
    return [testClub];
  }

  // Filter based on resume mode and failed clubs
  const processedSet = new Set(progress.processedClubs || []);
  const failedSet = new Set(retryFailedClubs ? [] : (progress.failedClubs || []));

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

  if (availableClubs.length === 0) {
    throw new Error('No clubs available to process based on current filters and configuration');
  }

  // Randomly select clubs up to maxClubsToProcess
  const shuffled = [...availableClubs].sort(() => Math.random() - 0.5);
  const selectedClubs = shuffled.slice(0, Math.min(maxClubsToProcess, shuffled.length));

  console.log(`📝 Processing ${selectedClubs.length} club(s): ${selectedClubs.join(', ')}`);

  return selectedClubs;
}
