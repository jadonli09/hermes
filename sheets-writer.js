import { appendOnce } from './automation/sheets-append.js';
import { canonicalPostUrl } from './automation/state.js';
// Google Sheets writer module for populating spreadsheet with event data
import { google } from 'googleapis';
import { retryWithBackoff } from './utils/retry.js';

/**
 * Authenticates with Google Sheets API using service account credentials
 * @param {string} credentialsPath - Path to Google service account JSON credentials file
 * @returns {Object} - Authenticated Google Sheets API client
 */
export async function authenticateSheets(credentialsPath) {
  try {
    console.log(`Loading Google Sheets credentials from: ${credentialsPath}...`);
    
    // Load service account credentials from JSON file
    const auth = new google.auth.GoogleAuth({
      keyFile: credentialsPath,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    
    // Create authenticated Google Sheets client
    const sheets = google.sheets({ version: 'v4', auth });
    
    console.log('Successfully authenticated with Google Sheets API');
    
    return sheets;
  } catch (error) {
    if (process.env.HERMES_STRICT_REFRESH === 'true') throw error;
    console.error('Error authenticating with Google Sheets:', error.message);
    throw new Error(`Failed to authenticate with Google Sheets: ${error.message}`);
  }
}

/**
 * Gets all existing post URLs from Google Sheets column F (Post URL)
 * @param {Object} sheets - Authenticated Google Sheets API client
 * @param {string} spreadsheetId - ID of the Google Spreadsheet
 * @returns {Promise<Set<string>>} - Set of existing post URLs
 */
export async function getExistingPostUrls(sheets, spreadsheetId) {
  try {
    // Get sheet name with retry logic
    const spreadsheet = await retryWithBackoff(async () => {
      return await sheets.spreadsheets.get({
        spreadsheetId: spreadsheetId
      });
    });

    if (!spreadsheet.data.sheets || spreadsheet.data.sheets.length === 0) {
      if (process.env.HERMES_STRICT_REFRESH === 'true') throw new Error('Spreadsheet has no sheets');
      console.warn('Warning: Spreadsheet has no sheets, returning empty URL set');
      return new Set();
    }

    const sheetName = spreadsheet.data.sheets[0].properties.title;
    const existingPostUrls = new Set();

    try {
      // Read existing post URLs from column F (post_url column, index 5)
      const existingDataResponse = await retryWithBackoff(async () => {
        return await sheets.spreadsheets.values.get({
          spreadsheetId: spreadsheetId,
          range: `${sheetName}!F:F` // Column F contains post_url
        });
      });

      if (existingDataResponse.data.values && existingDataResponse.data.values.length > 1) {
        // Skip header row (index 0), start from index 1
        for (let i = 1; i < existingDataResponse.data.values.length; i++) {
          const postUrl = existingDataResponse.data.values[i][0];
          if (postUrl && postUrl.trim()) {
            existingPostUrls.add(postUrl.trim());
          }
        }
        console.log(`Loaded ${existingPostUrls.size} existing post URL(s) from spreadsheet`);
      } else {
        console.log('No existing data found in spreadsheet (empty or header only)');
      }
    } catch (error) {
      if (process.env.HERMES_STRICT_REFRESH === 'true') throw error;
      // If there's an error reading existing data (e.g., empty sheet), continue with empty set
      console.warn(`Warning: Error reading existing post URLs from spreadsheet: ${error.message}`);
      console.warn('Continuing with empty URL set (will check all posts)');
    }

    return existingPostUrls;
  } catch (error) {
    if (process.env.HERMES_STRICT_REFRESH === 'true') throw error;
    console.error(`Error getting existing post URLs: ${error.message}`);
    console.warn('Continuing with empty URL set (will check all posts)');
    // Return empty Set on error to allow processing to continue
    return new Set();
  }
}

/**
 * Gets all existing events from the spreadsheet with their row indices
 * Handles duplicate post_urls by storing arrays of matching rows
 * @param {Object} sheets - Authenticated Google Sheets API client
 * @param {string} spreadsheetId - ID of the Google Spreadsheet
 * @returns {Promise<Map<string, Array<{rowIndex: number, data: Object}>>>} - Map of post_url to array of event data and row indices
 */
export async function getExistingEvents(sheets, spreadsheetId) {
  try {
    const spreadsheet = await retryWithBackoff(async () => {
      return await sheets.spreadsheets.get({
        spreadsheetId: spreadsheetId
      });
    });

    if (!spreadsheet.data.sheets || spreadsheet.data.sheets.length === 0) {
      return new Map();
    }

    const sheetName = spreadsheet.data.sheets[0].properties.title;
    const eventsMap = new Map();
    let duplicateCount = 0;

    try {
      // Read all existing data from columns A-J (10 columns)
      const existingDataResponse = await retryWithBackoff(async () => {
        return await sheets.spreadsheets.values.get({
          spreadsheetId: spreadsheetId,
          range: `${sheetName}!A:J` // All columns A through J
        });
      });

      if (existingDataResponse.data.values && existingDataResponse.data.values.length > 1) {
        // Skip header row (index 0), start from index 1
        for (let i = 1; i < existingDataResponse.data.values.length; i++) {
          const row = existingDataResponse.data.values[i];
          // Ensure row has at least 6 columns (post_url is column F, index 5)
          if (row && row.length >= 6) {
            const postUrl = (row[5] || '').trim(); // Column F (index 5) is post_url
            if (postUrl) {
              // Parse row data into event object
              // Columns: A=club_name, B=event_date, C=event_time, D=event_type, E=location, F=post_url, G=posted_date, H=confidence, I=description, J=last_updated
              const eventData = {
                club_name: (row[0] || '').trim(),
                event_date: (row[1] || '').trim(),
                event_time: (row[2] || '').trim(),
                event_type: (row[3] || '').trim(),
                location: (row[4] || '').trim(),
                post_url: postUrl,
                posted_date: (row[6] || '').trim(),
                confidence: (row[7] || '').trim(),
                description: (row[8] || '').trim(),
                last_updated: (row[9] || '').trim()
              };
              // Row index is 1-indexed for Sheets API (i+1 because we skipped header)
              const rowInfo = { rowIndex: i + 1, data: eventData };
              
              // Store as array to handle duplicate post_urls
              if (eventsMap.has(postUrl)) {
                eventsMap.get(postUrl).push(rowInfo);
                duplicateCount++;
              } else {
                eventsMap.set(postUrl, [rowInfo]);
              }
            }
          }
        }
        const totalEvents = Array.from(eventsMap.values()).reduce((sum, arr) => sum + arr.length, 0);
        console.log(`Loaded ${totalEvents} existing event(s) from spreadsheet (${eventsMap.size} unique post URLs)`);
        if (duplicateCount > 0) {
          console.warn(`⚠️  Warning: Found ${duplicateCount} duplicate post URL(s) in spreadsheet`);
        }
      } else {
        console.log('No existing data found in spreadsheet (empty or header only)');
      }
    } catch (error) {
      if (process.env.HERMES_STRICT_REFRESH === 'true') throw error;
      console.warn(`Warning: Error reading existing events from spreadsheet: ${error.message}`);
      console.warn('Continuing with empty events map');
    }

    return eventsMap;
  } catch (error) {
    if (process.env.HERMES_STRICT_REFRESH === 'true') throw error;
    console.error(`Error getting existing events: ${error.message}`);
    return new Map();
  }
}

/**
 * Normalizes date strings to YYYY-MM-DD format for consistent comparison
 * @param {string} dateStr - Date string in various formats
 * @returns {string} - Normalized date string in YYYY-MM-DD format, or empty string if invalid
 */
export function normalizeDate(dateStr) {
  if (!dateStr) return '';
  const trimmed = String(dateStr).trim();

  // If already in YYYY-MM-DD format, return as-is
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  // If in MM/DD/YYYY or M/D/YYYY format, convert to YYYY-MM-DD
  const mmddyyyy = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mmddyyyy) {
    const [, month, day, year] = mmddyyyy;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  // Try parsing as Date object and converting to YYYY-MM-DD
  try {
    const dateObj = new Date(trimmed);
    if (!isNaN(dateObj.getTime())) {
      const year = dateObj.getFullYear();
      const month = String(dateObj.getMonth() + 1).padStart(2, '0');
      const day = String(dateObj.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
  } catch (e) {
    // If date parsing fails, continue with original string
  }

  // Return trimmed string as fallback
  return trimmed;
}

/**
 * Decides whether two rows describe the same event.
 *
 * A single Instagram post can legitimately produce several rows:
 *   - multi-day events (Spirit Week) emit one event per day, same post_url
 *   - collab posts scraped from two clubs emit one event per club, same post_url
 *
 * So identity is (post_url, event_date, club_name), not post_url alone. Rows that
 * match on all three are true duplicates and should move together.
 *
 * @param {Object} existing - Existing event row from the spreadsheet
 * @param {Object} candidate - Incoming event
 * @returns {boolean} - True if both describe the same event
 */
export function isSameEvent(existing, candidate) {
  const url = v => String(v ?? '').trim();
  if (url(existing.post_url) !== url(candidate.post_url)) {
    return false;
  }

  // Sheet dates come back as MM/DD/YYYY; incoming ones are YYYY-MM-DD
  if (normalizeDate(existing.event_date) !== normalizeDate(candidate.event_date)) {
    return false;
  }

  const club = v => String(v ?? '').trim().toLowerCase();
  return club(existing.club_name) === club(candidate.club_name);
}

/**
 * Compares two event objects to determine if data has changed
 * @param {Object} existing - Existing event data from spreadsheet
 * @param {Object} newEvent - New event data to compare
 * @returns {boolean} - True if data has changed, false if identical
 */
export function compareEventData(existing, newEvent) {
  // Normalize function to handle null, undefined, and empty strings
  const normalize = (value) => {
    if (value === null || value === undefined) return '';
    return String(value).trim();
  };

  // Compare all relevant fields (excluding last_updated which will always change)
  const fieldsToCompare = [
    'club_name',
    'event_date',
    'event_time',
    'event_type',
    'location',
    'description'
  ];

  for (const field of fieldsToCompare) {
    const existingValue = normalize(existing[field] || '');
    const newValue = normalize(newEvent[field] || '');

    // Special handling for event_date - normalize date formats
    if (field === 'event_date') {
      if (normalizeDate(existingValue) !== normalizeDate(newValue)) {
        return true; // Data has changed
      }
    } else {
      if (existingValue !== newValue) {
        return true; // Data has changed
      }
    }
  }

  // Also compare confidence if both are numeric
  const existingConfidence = existing.confidence !== null && existing.confidence !== undefined
    ? String(existing.confidence).trim() : '';
  const newConfidence = newEvent.confidence !== null && newEvent.confidence !== undefined
    ? String(newEvent.confidence).trim() : '';
  if (existingConfidence !== newConfidence) {
    return true; // Confidence changed
  }

  return false; // No changes detected
}

/**
 * Updates or appends meeting data to Google Sheets spreadsheet
 * Updates existing rows if post_url exists and data has changed, otherwise appends new rows
 * @param {Object} sheets - Authenticated Google Sheets API client
 * @param {string} spreadsheetId - ID of the Google Spreadsheet
 * @param {Array} data - Array of meeting objects to update/append
 * @param {Map} existingEvents - Optional Map of existing events (from getExistingEvents)
 * @returns {Promise<{updated: number, appended: number, skipped: number}>} - Statistics about the operation
 */
export async function updateOrAppendToSheet(sheets, spreadsheetId, data, existingEvents = null, removeDuplicates = false) {
  try {
    if (!data || data.length === 0) {
      console.log('No data to update/append to spreadsheet');
      return { updated: 0, appended: 0, skipped: 0, duplicatesRemoved: 0 };
    }
    
    console.log(`Checking for existing events in spreadsheet...`);
    
    // Get sheet name with retry logic
    const spreadsheet = await retryWithBackoff(async () => {
      return await sheets.spreadsheets.get({
        spreadsheetId: spreadsheetId
      });
    });
    
    if (!spreadsheet.data.sheets || spreadsheet.data.sheets.length === 0) {
      throw new Error('Spreadsheet has no sheets');
    }
    
    const sheetName = spreadsheet.data.sheets[0].properties.title;
    const sheetId = spreadsheet.data.sheets[0].properties.sheetId;
    
    // Load existing events if not provided
    let existingEventsMap = existingEvents;
    if (!existingEventsMap) {
      existingEventsMap = await getExistingEvents(sheets, spreadsheetId);
    }
    
    // Helper function to format date for Google Sheets
    // Converts YYYY-MM-DD to MM/DD/YYYY format which Sheets recognizes better
    const formatDateForSheets = (dateString) => {
      if (!dateString || dateString === '') return '';
      
      // If it's already in YYYY-MM-DD format, convert to MM/DD/YYYY
      const dateMatch = dateString.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (dateMatch) {
        const [, year, month, day] = dateMatch;
        return `${month}/${day}/${year}`;
      }
      
      // If it's already in a different format, return as-is
      return dateString;
    };
    
    // Helper function to format timestamp for Last Updated column
    const formatTimestamp = () => {
      const now = new Date();
      // Format as readable date/time: "YYYY-MM-DD HH:MM:SS"
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      const hours = String(now.getHours()).padStart(2, '0');
      const minutes = String(now.getMinutes()).padStart(2, '0');
      const seconds = String(now.getSeconds()).padStart(2, '0');
      return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    };
    
    // Separate events into: updates, appends, and skips
    const eventsToUpdate = [];
    const eventsToAppend = [];
    let skippedCount = 0;
    
    const incoming = new Set();
    for (const meeting of data) {
      const identity = JSON.stringify([canonicalPostUrl(meeting.post_url), normalizeDate(meeting.event_date), String(meeting.club_name || '').trim().toLowerCase()]);
      if (incoming.has(identity)) { skippedCount++; continue; }
      incoming.add(identity);
      const postUrl = (meeting.post_url || '').trim();
      
      if (!postUrl) {
        // Skip events without post_url (cannot identify for updates)
        skippedCount++;
        continue;
      }
      
      // Match on identity, not just post_url. One post legitimately produces
      // several rows - a multi-day event yields one row per day, and a collab
      // post scraped from two clubs yields one row per club. Matching on
      // post_url alone would write every incoming event into every one of those
      // rows, collapsing a spirit week into N copies of a single day.
      const candidates = (existingEventsMap.get(postUrl) || [])
        .filter(e => isSameEvent(e.data, meeting));

      if (candidates.length > 0) {
        // Compare against the first match; genuine duplicate rows share data
        const dataChanged = compareEventData(candidates[0].data, meeting);

        if (dataChanged) {
          // Update every row that is genuinely this same event, so accidental
          // duplicate rows stay consistent with each other
          for (const existingEvent of candidates) {
            eventsToUpdate.push({
              rowIndex: existingEvent.rowIndex,
              meeting: meeting
            });
          }
          if (candidates.length > 1) {
            console.log(`  Found ${candidates.length} duplicate row(s) for this event, will update all`);
          }
        } else {
          skippedCount++;
          if (candidates.length > 1) {
            console.log(`  Skipping ${candidates.length} duplicate row(s) for this event (no changes)`);
          }
        }
      } else {
        // Either a brand new post, or a further day/club of a post already
        // present - both are appends
        eventsToAppend.push(meeting);
      }
    }
    
    console.log(`Found ${eventsToUpdate.length} event(s) to update, ${eventsToAppend.length} event(s) to append, ${skippedCount} event(s) skipped`);
    
    // Track successfully updated rows for statistics and formatting
    let successfullyUpdatedCount = 0;
    
    // Update existing rows
    if (eventsToUpdate.length > 0) {
      console.log(`Updating ${eventsToUpdate.length} existing row(s)...`);
      
      // Get current row count to validate row indices
      let maxRow = 0;
      try {
        const currentRowResponse = await retryWithBackoff(async () => {
          return await sheets.spreadsheets.values.get({
            spreadsheetId: spreadsheetId,
            range: `${sheetName}!A:A`
          });
        });
        maxRow = currentRowResponse.data.values ? currentRowResponse.data.values.length : 0;
      } catch (error) {
        if (process.env.HERMES_STRICT_REFRESH === 'true') throw error;
        console.warn('Warning: Could not get row count for validation:', error.message);
      }
      
      // Track successfully updated rows for formatting
      const successfullyUpdatedRows = [];
      
      // Update each row individually using values.update (more reliable than updateCells)
      for (const { rowIndex, meeting } of eventsToUpdate) {
        // Validate row index
        if (maxRow > 0 && (rowIndex < 2 || rowIndex > maxRow)) {
          console.warn(`Warning: Invalid row index ${rowIndex} (valid range: 2-${maxRow}), skipping update for post ${meeting.post_url}`);
          continue;
        }
        
        // Convert event to row format with 10 columns (A-J)
        // If needs_review flag is set, prepend marker to description
        const description = meeting.needs_review
          ? `[NEEDS REVIEW] ${meeting.description || ''}`
          : (meeting.description || '');

        const row = [
          meeting.club_name || '',
          formatDateForSheets(meeting.event_date),
          meeting.event_time || '',
          meeting.event_type || '',
          meeting.location || '',
          meeting.post_url || '',
          formatDateForSheets(meeting.posted_date),
          meeting.confidence !== null && meeting.confidence !== undefined ? meeting.confidence : '',
          description,
          formatTimestamp() // Last Updated (column J)
        ];

        // Update the row using values.update (simpler and more reliable)
        try {
          await retryWithBackoff(async () => {
            return await sheets.spreadsheets.values.update({
              spreadsheetId: spreadsheetId,
              range: `${sheetName}!A${rowIndex}:J${rowIndex}`,
              valueInputOption: 'USER_ENTERED',
              resource: {
                values: [row]
              }
            });
          });
          successfullyUpdatedRows.push(rowIndex);
          successfullyUpdatedCount++;
        } catch (error) {
        if (process.env.HERMES_STRICT_REFRESH === 'true') throw error;
          console.error(`Error updating row ${rowIndex} for post ${meeting.post_url}:`, error.message);
          // Continue with other updates even if one fails
        }
      }
      
      console.log(`Successfully updated ${successfullyUpdatedCount} row(s)`);
      
      // Format date columns for successfully updated rows
      if (successfullyUpdatedRows.length > 0) {
        try {
          const formatRequests = successfullyUpdatedRows.map((rowIndex) => {
            const rowIdx = rowIndex - 1; // Convert to 0-indexed
            return [
              // Format Event Date column (B) as date
              {
                repeatCell: {
                  range: {
                    sheetId: sheetId,
                    startRowIndex: rowIdx,
                    endRowIndex: rowIdx + 1,
                    startColumnIndex: 1, // Column B (0-indexed)
                    endColumnIndex: 2
                  },
                  cell: {
                    userEnteredFormat: {
                      numberFormat: {
                        type: 'DATE',
                        pattern: 'mm/dd/yyyy'
                      }
                    }
                  },
                  fields: 'userEnteredFormat.numberFormat'
                }
              },
              // Format Posted Date column (G) as date
              {
                repeatCell: {
                  range: {
                    sheetId: sheetId,
                    startRowIndex: rowIdx,
                    endRowIndex: rowIdx + 1,
                    startColumnIndex: 6, // Column G (0-indexed)
                    endColumnIndex: 7
                  },
                  cell: {
                    userEnteredFormat: {
                      numberFormat: {
                        type: 'DATE',
                        pattern: 'mm/dd/yyyy'
                      }
                    }
                  },
                  fields: 'userEnteredFormat.numberFormat'
                }
              },
              // Format Last Updated column (J) as date/time
              {
                repeatCell: {
                  range: {
                    sheetId: sheetId,
                    startRowIndex: rowIdx,
                    endRowIndex: rowIdx + 1,
                    startColumnIndex: 9, // Column J (0-indexed)
                    endColumnIndex: 10
                  },
                  cell: {
                    userEnteredFormat: {
                      numberFormat: {
                        type: 'DATE_TIME',
                        pattern: 'yyyy-mm-dd hh:mm:ss'
                      }
                    }
                  },
                  fields: 'userEnteredFormat.numberFormat'
                }
              }
            ];
          }).flat(); // Flatten the array of arrays
          
          await retryWithBackoff(async () => {
            return await sheets.spreadsheets.batchUpdate({
              spreadsheetId: spreadsheetId,
              resource: {
                requests: formatRequests
              }
            });
          });
          console.log('Date columns formatted for updated rows');
        } catch (formatError) {
          console.warn('Warning: Could not format date columns for updated rows:', formatError.message);
        }
      }
    }
    
    // Append new rows
    if (eventsToAppend.length > 0) {
      console.log(`Appending ${eventsToAppend.length} new row(s)...`);
      
      // Convert event objects to row format with 10 columns (A-J)
      const rows = eventsToAppend.map(meeting => {
        // If needs_review flag is set, prepend marker to description
        const description = meeting.needs_review
          ? `[NEEDS REVIEW] ${meeting.description || ''}`
          : (meeting.description || '');

        return [
          meeting.club_name || '',
          formatDateForSheets(meeting.event_date),
          meeting.event_time || '',
          meeting.event_type || '',
          meeting.location || '',
          meeting.post_url || '',
          formatDateForSheets(meeting.posted_date),
          meeting.confidence !== null && meeting.confidence !== undefined ? meeting.confidence : '',
          description,
          formatTimestamp() // Last Updated (column J)
        ];
      });

      // Persist intent and never retry a non-idempotent append blindly
      // Range: 'Sheet1!A:J' (or first sheet, columns A through J)
      const response = await appendOnce(async () => {
        return await sheets.spreadsheets.values.append({
          spreadsheetId: spreadsheetId,
          range: `${sheetName}!A:J`,
        valueInputOption: 'USER_ENTERED', // Allows formulas, dates, etc. to be interpreted
        insertDataOption: 'INSERT_ROWS', // Insert new rows instead of overwriting
        resource: {
          values: rows
        }
      }, { retry: false });
    }, rows);
    
    console.log(`Successfully appended ${rows.length} new row(s) to spreadsheet`);
      
      // Format date columns for newly appended rows
      if (eventsToAppend.length > 0) {
        try {
        // Get current number of rows to determine where new rows were added
        const currentRowResponse = await retryWithBackoff(async () => {
          return await sheets.spreadsheets.values.get({
            spreadsheetId: spreadsheetId,
            range: `${sheetName}!A:A`
          });
        });
        const currentRowCount = currentRowResponse.data.values ? currentRowResponse.data.values.length : 1;
        
        // Calculate the range of newly added rows (skip header row)
          const startRow = currentRowCount - eventsToAppend.length; // 0-indexed, header is row 0
        const endRow = currentRowCount; // 0-indexed, exclusive
        
        await retryWithBackoff(async () => {
          return await sheets.spreadsheets.batchUpdate({
            spreadsheetId: spreadsheetId,
            resource: {
              requests: [
                // Format Event Date column (B) as date
                {
                  repeatCell: {
                    range: {
                      sheetId: sheetId,
                      startRowIndex: startRow,
                      endRowIndex: endRow,
                      startColumnIndex: 1, // Column B (0-indexed)
                      endColumnIndex: 2
                    },
                    cell: {
                      userEnteredFormat: {
                        numberFormat: {
                          type: 'DATE',
                          pattern: 'mm/dd/yyyy'
                        }
                      }
                    },
                    fields: 'userEnteredFormat.numberFormat'
                  }
                },
                // Format Posted Date column (G) as date
                {
                  repeatCell: {
                    range: {
                      sheetId: sheetId,
                      startRowIndex: startRow,
                      endRowIndex: endRow,
                      startColumnIndex: 6, // Column G (0-indexed)
                      endColumnIndex: 7
                    },
                    cell: {
                      userEnteredFormat: {
                        numberFormat: {
                          type: 'DATE',
                          pattern: 'mm/dd/yyyy'
                        }
                      }
                    },
                    fields: 'userEnteredFormat.numberFormat'
                  }
                },
                // Format Last Updated column (J) as date/time
                {
                  repeatCell: {
                    range: {
                      sheetId: sheetId,
                      startRowIndex: startRow,
                      endRowIndex: endRow,
                      startColumnIndex: 9, // Column J (0-indexed)
                      endColumnIndex: 10
                    },
                    cell: {
                      userEnteredFormat: {
                        numberFormat: {
                          type: 'DATE_TIME',
                          pattern: 'yyyy-mm-dd hh:mm:ss'
                        }
                      }
                    },
                    fields: 'userEnteredFormat.numberFormat'
                  }
                }
              ]
            }
          });
        });
        console.log('Date columns formatted successfully');
      } catch (formatError) {
        console.warn('Warning: Could not format date columns:', formatError.message);
        // Don't throw - formatting is nice to have but not critical
      }
      }
    }
    
    // Optionally remove duplicate rows after processing
    let duplicatesRemoved = 0;
    if (removeDuplicates) {
      // TODO: Implement removeDuplicateRows function if needed
      // For now, duplicates are handled by the update logic which updates all rows with the same post_url
      console.warn('Warning: removeDuplicates=true but removeDuplicateRows function not implemented');
      duplicatesRemoved = 0;
    }
    
    return {
      updated: successfullyUpdatedCount,
      appended: eventsToAppend.length,
      skipped: skippedCount,
      duplicatesRemoved: duplicatesRemoved
    };
    
  } catch (error) {
    if (process.env.HERMES_STRICT_REFRESH === 'true') throw error;
    console.error('Error updating/appending to spreadsheet:', error.message);
    throw new Error(`Failed to update/append data to spreadsheet: ${error.message}`);
  }
}

/**
 * Sorts the spreadsheet by event_date column (column B) in ascending order
 * @param {Object} sheets - Authenticated Google Sheets API client
 * @param {string} spreadsheetId - ID of the Google Spreadsheet
 * @returns {Promise<void>}
 */
export async function sortSheetByDate(sheets, spreadsheetId) {
  try {
    console.log('Sorting spreadsheet by event_date...');

    // First, get the sheet ID of the first sheet (Sheet1) with retry logic
    const spreadsheet = await retryWithBackoff(async () => {
      return await sheets.spreadsheets.get({
        spreadsheetId: spreadsheetId
      });
    });

    // Check if spreadsheet has sheets
    if (!spreadsheet.data.sheets || spreadsheet.data.sheets.length === 0) {
      throw new Error('Spreadsheet has no sheets');
    }

    const sheetId = spreadsheet.data.sheets[0].properties.sheetId;
    const sheetName = spreadsheet.data.sheets[0].properties.title;

    // Get the last row with data to determine the sort range with retry logic
    const lastRowResponse = await retryWithBackoff(async () => {
      return await sheets.spreadsheets.values.get({
        spreadsheetId: spreadsheetId,
        range: `${sheetName}!A:A` // Get column A to find last row
      });
    });

    const lastRow = lastRowResponse.data.values ? lastRowResponse.data.values.length : 1;

    // Don't sort if there's only a header row
    if (lastRow <= 1) {
      console.log('No data rows to sort');
      return;
    }

    // Use batchUpdate to sort by event_date column (column B, index 1) with retry logic
    await retryWithBackoff(async () => {
      return await sheets.spreadsheets.batchUpdate({
        spreadsheetId: spreadsheetId,
        resource: {
          requests: [
            {
              sortRange: {
                range: {
                  sheetId: sheetId,
                  startRowIndex: 1, // Skip header row (0-indexed, so 1 = row 2)
                  endRowIndex: lastRow,
                  startColumnIndex: 0, // Column A
                  endColumnIndex: 10 // Column J
                },
                sortSpecs: [
                  {
                    dimensionIndex: 1, // Column B (event_date) - 0-indexed, so 1 = column B
                    sortOrder: 'ASCENDING' // Ascending order (chronological)
                  }
                ]
              }
            }
          ]
        }
      });
    });

    console.log(`Successfully sorted spreadsheet by event_date (${lastRow - 1} data rows)`);
    
  } catch (error) {
    if (process.env.HERMES_STRICT_REFRESH === 'true') throw error;
    console.error('Error sorting spreadsheet:', error.message);
    throw new Error(`Failed to sort spreadsheet: ${error.message}`);
  }
}
