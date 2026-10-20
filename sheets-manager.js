// Google Sheets manager for high-level spreadsheet operations
import {
  authenticateSheets,
  getExistingPostUrls,
  getExistingEvents,
  updateOrAppendToSheet,
  sortSheetByDate
} from './sheets-writer.js';

/**
 * Sheets manager class for managing Google Sheets operations
 */
export class SheetsManager {
  constructor() {
    this.sheets = null;
    this.spreadsheetId = null;
    this.existingPostUrls = new Set();
    this.existingEvents = null;
  }

  /**
   * Authenticates with Google Sheets API
   * @param {string} credentialsPath - Path to Google credentials JSON file
   * @returns {Promise<Object>} - Authenticated sheets client
   */
  async authenticate(credentialsPath) {
    console.log('\n--- Authenticating with Google Sheets ---');
    this.sheets = await authenticateSheets(credentialsPath);
    console.log('✓ Authenticated with Google Sheets');
    return this.sheets;
  }

  /**
   * Sets the spreadsheet ID for operations
   * @param {string} spreadsheetId - Google Spreadsheet ID
   */
  setSpreadsheetId(spreadsheetId) {
    this.spreadsheetId = spreadsheetId;
  }

  /**
   * Loads existing post URLs for deduplication
   * @returns {Promise<Set<string>>} - Set of existing post URLs
   */
  async loadExistingPostUrls() {
    if (!this.sheets || !this.spreadsheetId) {
      throw new Error('SheetsManager not initialized. Call authenticate() and setSpreadsheetId() first.');
    }

    console.log('\n--- Loading Existing Post URLs ---');
    try {
      this.existingPostUrls = await getExistingPostUrls(this.sheets, this.spreadsheetId);
      console.log(`✓ Loaded ${this.existingPostUrls.size} existing post URL(s) for deduplication`);
    } catch (error) {
      if (process.env.HERMES_STRICT_REFRESH === 'true') throw error;
      console.error(`Error loading existing post URLs: ${error.message}`);
      console.warn('Continuing with empty URL set (will check all posts)');
      this.existingPostUrls = new Set();
    }

    return this.existingPostUrls;
  }

  /**
   * Loads existing events for update comparison
   * @returns {Promise<Map>} - Map of post URLs to event data
   */
  async loadExistingEvents() {
    if (!this.sheets || !this.spreadsheetId) {
      throw new Error('SheetsManager not initialized. Call authenticate() and setSpreadsheetId() first.');
    }

    try {
      this.existingEvents = await getExistingEvents(this.sheets, this.spreadsheetId);
      const totalEvents = Array.from(this.existingEvents.values()).reduce((sum, arr) => sum + arr.length, 0);
      console.log(`✓ Loaded ${totalEvents} existing event(s) for update comparison (${this.existingEvents.size} unique post URLs)`);
    } catch (error) {
      if (process.env.HERMES_STRICT_REFRESH === 'true') throw error;
      console.warn(`Warning: Could not load existing events: ${error.message}`);
      console.warn('Continuing with update/append (will treat all as new)');
      this.existingEvents = null;
    }

    return this.existingEvents;
  }

  /**
   * Writes results to the spreadsheet
   * @param {Array} results - Array of meeting data objects
   * @param {boolean} removeDuplicates - Whether to remove duplicate entries
   * @returns {Promise<Object>} - Statistics about the write operation
   */
  async writeResults(results, removeDuplicates = false) {
    if (!this.sheets || !this.spreadsheetId) {
      throw new Error('SheetsManager not initialized. Call authenticate() and setSpreadsheetId() first.');
    }

    if (!results || results.length === 0) {
      console.log('\n⚠️  No meeting data to write to spreadsheet');
      return { updated: 0, appended: 0, skipped: 0, duplicatesRemoved: 0 };
    }

    console.log('\n--- Writing to Google Sheets ---');

    // Load existing events if not already loaded
    if (!this.existingEvents) {
      await this.loadExistingEvents();
    }

    const stats = await updateOrAppendToSheet(
      this.sheets,
      this.spreadsheetId,
      results,
      this.existingEvents,
      removeDuplicates
    );

    console.log('✓ Successfully wrote data to spreadsheet');
    console.log(`  - Updated: ${stats.updated} row(s)`);
    console.log(`  - Appended: ${stats.appended} row(s)`);
    console.log(`  - Skipped: ${stats.skipped} row(s) (no changes)`);
    if (stats.duplicatesRemoved > 0) {
      console.log(`  - Duplicates removed: ${stats.duplicatesRemoved} row(s)`);
    }

    return stats;
  }

  /**
   * Sorts the spreadsheet by meeting date
   * @returns {Promise<void>}
   */
  async sortByDate() {
    if (!this.sheets || !this.spreadsheetId) {
      throw new Error('SheetsManager not initialized. Call authenticate() and setSpreadsheetId() first.');
    }

    console.log('\n--- Sorting Spreadsheet ---');
    await sortSheetByDate(this.sheets, this.spreadsheetId);
    console.log('✓ Successfully sorted spreadsheet by date');
  }

  /**
   * Checks if a post URL already exists in the spreadsheet
   * @param {string} postUrl - Post URL to check
   * @returns {boolean} - True if URL exists
   */
  hasPost(postUrl) {
    return this.existingPostUrls.has(postUrl);
  }

  /**
   * Performs a read-only validation of the spreadsheet connection
   * @returns {Promise<boolean>} - True if connection is valid
   */
  async validateConnection() {
    if (!this.sheets || !this.spreadsheetId) {
      return false;
    }

    try {
      // Try to get spreadsheet metadata
      await this.sheets.spreadsheets.get({
        spreadsheetId: this.spreadsheetId
      });
      return true;
    } catch (error) {
      if (process.env.HERMES_STRICT_REFRESH === 'true') throw error;
      console.error(`Spreadsheet connection validation failed: ${error.message}`);
      return false;
    }
  }
}

/**
 * Creates and initializes a SheetsManager
 * @param {string} credentialsPath - Path to Google credentials
 * @param {string} spreadsheetId - Google Spreadsheet ID
 * @returns {Promise<SheetsManager>} - Initialized SheetsManager
 */
export async function createSheetsManager(credentialsPath, spreadsheetId) {
  const manager = new SheetsManager();
  await manager.authenticate(credentialsPath);
  manager.setSpreadsheetId(spreadsheetId);
  return manager;
}
