/**
 * Google Apps Script: Sync Spreadsheet Events to Google Calendar
 *
 * Creates ONE all-day event per date containing all club events in the description.
 * Excludes Announcements - only includes Fundraisers, Club Meetings, Workshops, Social Events, etc.
 *
 * SETUP INSTRUCTIONS:
 * 1. Open your Google Spreadsheet
 * 2. Go to Extensions > Apps Script
 * 3. Delete any existing code and paste this entire script
 * 4. Enable the Advanced Calendar Service:
 *    - In the Apps Script editor, click "+" next to "Services" in the left sidebar
 *    - Find "Google Calendar API" and click "Add"
 * 5. Run setupTrigger() once to enable automatic syncing
 * 6. Authorize the script when prompted
 *
 * SPREADSHEET COLUMNS (A-K):
 * A: Club Name | B: Event Date | C: Event Time | D: Event Type | E: Location
 * F: Post URL | G: Posted Date | H: Confidence | I: Description | J: Last Updated
 * K: Calendar Synced Date (tracks last sync per date)
 */

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
  // Your Google Calendar ID
  CALENDAR_ID: 'a2d44db8fa158496ccc3f92199adc0bcdc07599d15a6e93cedf31f97676281ba@group.calendar.google.com',

  // Minimum confidence threshold (0.0 - 1.0) - events below this won't be included
  MIN_CONFIDENCE: 0.3,

  // Event types to EXCLUDE from calendar (case-insensitive)
  // All other types will be included: Club Meeting, Fundraiser, Volunteer, Social Event,
  // Competition, Workshop, Game, Tryout, Dance, Assembly, Election, Activity, Spirit Day, Event, Other
  EXCLUDED_TYPES: ['announcement'],

  // Title for the daily all-day event
  DAILY_EVENT_TITLE: 'Hermes',

  // Sheet name (usually 'Sheet1' or your custom name)
  SHEET_NAME: 'Sheet1',

  // Column indices (0-based)
  COLUMNS: {
    CLUB_NAME: 0,      // A
    EVENT_DATE: 1,     // B
    EVENT_TIME: 2,     // C
    EVENT_TYPE: 3,     // D
    LOCATION: 4,       // E
    POST_URL: 5,       // F
    POSTED_DATE: 6,    // G
    CONFIDENCE: 7,     // H
    DESCRIPTION: 8,    // I
    LAST_UPDATED: 9,   // J
    CALENDAR_SYNCED: 10 // K
  }
};

// ============================================
// MAIN FUNCTIONS
// ============================================

/**
 * Main sync function - groups events by date and creates/updates all-day events
 */
function syncEventsToCalendar() {
  const sheet = getSheet();

  // Verify calendar access via Advanced Calendar Service
  try {
    const calendarMeta = Calendar.Calendars.get(CONFIG.CALENDAR_ID);
    Logger.log(`Using calendar: ${calendarMeta.summary}`);
  } catch (error) {
    Logger.log('ERROR: Calendar not found. Check CALENDAR_ID in CONFIG and ensure the Advanced Calendar Service is enabled.');
    return;
  }

  // Ensure Calendar Synced column exists
  ensureCalendarColumn(sheet);

  // Get all data (skip header row)
  const data = sheet.getDataRange().getValues();

  // Group events by date
  const eventsByDate = groupEventsByDate(data);

  Logger.log(`Found events on ${Object.keys(eventsByDate).length} unique date(s)`);

  let created = 0;
  let updated = 0;
  let skipped = 0;

  // Process each date
  for (const dateKey of Object.keys(eventsByDate)) {
    const result = processDailyEvents(dateKey, eventsByDate[dateKey], null, sheet);

    switch (result) {
      case 'created': created++; break;
      case 'updated': updated++; break;
      case 'skipped': skipped++; break;
    }
  }

  Logger.log(`\n=== SYNC COMPLETE ===`);
  Logger.log(`Dates with new events created: ${created}`);
  Logger.log(`Dates with events updated: ${updated}`);
  Logger.log(`Dates skipped (no qualifying events): ${skipped}`);
}

/**
 * Group all spreadsheet rows by event date
 * @returns {Object} - { 'YYYY-MM-DD': [array of event objects] }
 */
function groupEventsByDate(data) {
  const cols = CONFIG.COLUMNS;
  const grouped = {};

  // Skip header row (index 0)
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const rowNum = i + 1;

    const eventDate = row[cols.EVENT_DATE];
    const eventType = String(row[cols.EVENT_TYPE] || '').trim();
    const confidence = parseFloat(row[cols.CONFIDENCE]) || 0;
    const clubName = row[cols.CLUB_NAME];

    // Skip if no date
    if (!eventDate) continue;

    // Skip if no club name
    if (!clubName) continue;

    // Skip if confidence too low
    if (confidence < CONFIG.MIN_CONFIDENCE) continue;

    // Skip excluded event types (like Announcements)
    const isExcluded = CONFIG.EXCLUDED_TYPES.some(
      excluded => eventType.toLowerCase() === excluded.toLowerCase()
    );
    if (isExcluded) continue;

    // Parse date to consistent format
    const dateKey = formatDateKey(eventDate);
    if (!dateKey) continue;

    // Create event object
    const event = {
      rowNum: rowNum,
      clubName: String(clubName).trim(),
      eventTime: normalizeCellTime(row[cols.EVENT_TIME]),
      eventType: eventType,
      location: String(row[cols.LOCATION] || '').trim(),
      postUrl: String(row[cols.POST_URL] || '').trim(),
      description: String(row[cols.DESCRIPTION] || '').trim(),
      confidence: confidence,
      lastUpdated: row[cols.LAST_UPDATED]
    };

    // Add to grouped object
    if (!grouped[dateKey]) {
      grouped[dateKey] = [];
    }
    grouped[dateKey].push(event);
  }

  return grouped;
}

/**
 * Process all events for a single date - create or update the all-day event
 * Uses Advanced Calendar Service for HTML description support
 */
function processDailyEvents(dateKey, events, calendar, sheet) {
  if (!events || events.length === 0) {
    return 'skipped';
  }

  // Validate the date
  const eventDate = new Date(dateKey + 'T00:00:00');
  if (isNaN(eventDate.getTime())) {
    Logger.log(`Invalid date: ${dateKey}`);
    return 'skipped';
  }

  // Build HTML description and title
  const description = buildDailyDescription(events);
  const title = `${CONFIG.DAILY_EVENT_TITLE} (${events.length})`;

  // End date is exclusive for all-day events (next day)
  const endDate = new Date(eventDate);
  endDate.setDate(endDate.getDate() + 1);

  // Format dates as YYYY-MM-DD for the Calendar API
  const startDateStr = formatDateKey(eventDate);
  const endDateStr = formatDateKey(endDate);

  // Search for existing event on this date
  const existingEvent = findExistingEvent(dateKey);

  try {
    if (existingEvent) {
      // Update existing event with HTML description
      Calendar.Events.patch(
        { summary: title, description: description },
        CONFIG.CALENDAR_ID,
        existingEvent.id
      );

      Logger.log(`Updated: ${dateKey} - ${events.length} event(s)`);
      markRowsSynced(sheet, events, dateKey);
      return 'updated';
    }

    // Create new all-day event with HTML description
    Calendar.Events.insert(
      {
        summary: title,
        description: description,
        start: { date: startDateStr },
        end: { date: endDateStr }
      },
      CONFIG.CALENDAR_ID
    );

    Logger.log(`Created: ${dateKey} - ${events.length} event(s)`);
    markRowsSynced(sheet, events, dateKey);
    return 'created';
  } catch (error) {
    Logger.log(`ERROR processing event for ${dateKey}: ${error.message}`);
    return 'skipped';
  }
}

/**
 * Find an existing Hermes event for a given date using the Calendar API
 */
function findExistingEvent(dateKey) {
  const startOfDay = new Date(dateKey + 'T00:00:00');
  const endOfDay = new Date(dateKey + 'T23:59:59');

  try {
    const response = Calendar.Events.list(CONFIG.CALENDAR_ID, {
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      q: CONFIG.DAILY_EVENT_TITLE,
      singleEvents: true
    });

    if (response.items && response.items.length > 0) {
      return response.items[0];
    }
  } catch (error) {
    Logger.log(`Warning: Could not search for existing events on ${dateKey}: ${error.message}`);
  }

  return null;
}

/**
 * Get an emoji based on event type
 */
function getEventEmoji(eventType) {
  const emojiMap = {
    'Club Meeting': '🤝',
    'Fundraiser': '💰',
    'Volunteer': '🤲',
    'Social Event': '🎉',
    'Competition': '🏆',
    'Workshop': '📚',
    'Game': '🏀',
    'Tryout': '🎯',
    'Dance': '💃',
    'Assembly': '🎤',
    'Election': '🗳️',
    'Activity': '⭐',
    'Spirit Day': '🎨',
    'Event': '📅',
    'Other': '📌'
  };
  return emojiMap[eventType] || '📌';
}

/**
 * Build HTML description for a daily all-day event
 * Format: emoji <b>org</b> (<i>type</i>) - time · location
 */
function buildDailyDescription(events) {
  // Sort events by time (Lunch first, then After School, then specific times)
  const sortedEvents = events.sort((a, b) => {
    return getTimeSortOrder(a.eventTime) - getTimeSortOrder(b.eventTime);
  });

  const blocks = [];

  for (const event of sortedEvents) {
    const emoji = getEventEmoji(event.eventType);
    const type = event.eventType || 'Event';

    // Build time/location suffix
    const timeLoc = formatTimeLoc(event.eventTime, event.location);
    const suffix = timeLoc ? ` - ${timeLoc}` : '';

    // Header: emoji <b>OrgName</b> (<i>Type</i>) - Time · Location
    let block = `${emoji} <b>${escapeHtml(event.clubName)}</b> (<i>${escapeHtml(type)}</i>)${suffix}<br>`;

    // Description
    if (event.description) {
      block += `${escapeHtml(event.description)}<br>`;
    }

    // Source as clickable underlined hyperlink
    if (event.postUrl) {
      const displayUrl = shortenUrl(event.postUrl);
      block += `Source: <a href="${event.postUrl}"><u>${displayUrl}</u></a><br>`;
    }

    blocks.push(block);
  }

  return blocks.join('<br>');
}

/**
 * Escape special HTML characters
 */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Shorten a URL for display (strip protocol and trailing slash)
 */
function shortenUrl(url) {
  return url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
}

/**
 * Format time and location into a single string
 */
function formatTimeLoc(timeStr, location) {
  const parts = [];

  if (timeStr) {
    parts.push(formatTimeDisplay(timeStr));
  }

  if (location) {
    parts.push(location);
  }

  return parts.join(' · ');
}

/**
 * Get sort order for event times (earlier times first)
 */
function getTimeSortOrder(timeStr) {
  if (!timeStr) return 999;

  const time = timeStr.toLowerCase();

  if (time.includes('before school')) return 1;
  if (time.includes('lunch')) return 2;
  if (time.includes('after school')) return 3;

  // Try to parse specific time
  const match = time.match(/(\d{1,2}):?(\d{2})?\s*(am|pm)?/i);
  if (match) {
    let hours = parseInt(match[1], 10);
    const isPM = match[3] && match[3].toLowerCase() === 'pm';
    if (isPM && hours !== 12) hours += 12;
    if (!isPM && hours === 12) hours = 0;
    return 10 + hours; // 10-33 range for specific times
  }

  return 500; // Unknown times at end
}

/**
 * Converts a time cell into a display string.
 *
 * getValues() returns a real Date for any cell Sheets recognised as a time, using
 * the spreadsheet epoch (Dec 30 1899) as the date part. Stringifying that directly
 * produced calendar entries reading "Sat Dec 30 1899 16:00:00 GMT-0800 (Pacific
 * Standard Time)" instead of "4:00 PM". Text values ("Lunch") pass through.
 */
function normalizeCellTime(value) {
  if (value === null || value === undefined || value === '') return '';

  if (Object.prototype.toString.call(value) === '[object Date]') {
    if (isNaN(value.getTime())) return '';
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'h:mm a');
  }

  return String(value).trim();
}

/**
 * Format time for display in description
 */
function formatTimeDisplay(timeStr) {
  if (!timeStr) return '';

  const time = timeStr.toLowerCase();

  if (time.includes('lunch')) return 'Lunch';
  if (time.includes('after school')) return 'After School';
  if (time.includes('before school')) return 'Before School';

  return timeStr;
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Get the active sheet
 */
function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(CONFIG.SHEET_NAME) || ss.getSheets()[0];
}

/**
 * Ensure the Calendar Synced column (K) exists with header
 */
function ensureCalendarColumn(sheet) {
  const headers = sheet.getRange(1, 1, 1, 11).getValues()[0];

  if (!headers[10] || headers[10] === '') {
    sheet.getRange(1, 11).setValue('Calendar Synced');
    Logger.log('Added "Calendar Synced" header to column K');
  }
}

/**
 * Format a date to YYYY-MM-DD string
 */
function formatDateKey(dateValue) {
  let dateObj;

  if (dateValue instanceof Date) {
    dateObj = dateValue;
  } else {
    dateObj = new Date(dateValue);
  }

  if (isNaN(dateObj.getTime())) {
    return null;
  }

  const year = dateObj.getFullYear();
  const month = String(dateObj.getMonth() + 1).padStart(2, '0');
  const day = String(dateObj.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

/**
 * Mark rows as synced in the spreadsheet
 */
function markRowsSynced(sheet, events, dateKey) {
  const timestamp = new Date().toISOString();
  const col = CONFIG.COLUMNS.CALENDAR_SYNCED + 1; // Convert to 1-indexed

  for (const event of events) {
    sheet.getRange(event.rowNum, col).setValue(timestamp);
  }
}

// ============================================
// TRIGGER MANAGEMENT
// ============================================

/**
 * Set up automatic trigger to run sync every hour
 */
function setupTrigger() {
  removeTriggers();

  ScriptApp.newTrigger('syncEventsToCalendar')
    .timeBased()
    .everyHours(1)
    .create();

  Logger.log('Trigger set up: syncEventsToCalendar will run every hour');
}

/**
 * Set up trigger to run every 30 minutes
 */
function setupFrequentTrigger() {
  removeTriggers();

  ScriptApp.newTrigger('syncEventsToCalendar')
    .timeBased()
    .everyMinutes(30)
    .create();

  Logger.log('Trigger set up: syncEventsToCalendar will run every 30 minutes');
}

/**
 * Set up daily trigger
 */
function setupDailyTrigger() {
  removeTriggers();

  ScriptApp.newTrigger('syncEventsToCalendar')
    .timeBased()
    .everyDays(1)
    .atHour(6)
    .create();

  Logger.log('Trigger set up: syncEventsToCalendar will run daily at 6 AM');
}

/**
 * Remove all existing triggers
 */
function removeTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === 'syncEventsToCalendar') {
      ScriptApp.deleteTrigger(trigger);
    }
  }
  Logger.log('Removed existing triggers');
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

/**
 * Delete all calendar events created by this script
 */
function deleteAllSyncedEvents() {
  const startDate = new Date();
  startDate.setFullYear(startDate.getFullYear() - 1);
  const endDate = new Date();
  endDate.setFullYear(endDate.getFullYear() + 1);

  let deleted = 0;
  let pageToken = null;

  do {
    const response = Calendar.Events.list(CONFIG.CALENDAR_ID, {
      timeMin: startDate.toISOString(),
      timeMax: endDate.toISOString(),
      q: CONFIG.DAILY_EVENT_TITLE,
      singleEvents: true,
      pageToken: pageToken
    });

    if (response.items) {
      for (const event of response.items) {
        Calendar.Events.remove(CONFIG.CALENDAR_ID, event.id);
        deleted++;
      }
    }

    pageToken = response.nextPageToken;
  } while (pageToken);

  Logger.log(`Deleted ${deleted} calendar events`);

  // Clear sync timestamps from spreadsheet
  clearSyncTimestamps();
}

/**
 * Clear all sync timestamps from spreadsheet
 */
function clearSyncTimestamps() {
  const sheet = getSheet();
  const lastRow = sheet.getLastRow();

  if (lastRow > 1) {
    const range = sheet.getRange(2, CONFIG.COLUMNS.CALENDAR_SYNCED + 1, lastRow - 1, 1);
    range.clearContent();
    Logger.log(`Cleared sync timestamps from ${lastRow - 1} rows`);
  }
}

/**
 * Test function - show what would be synced without creating events
 */
function testSync() {
  Logger.log('=== TEST SYNC (preview only) ===\n');

  const sheet = getSheet();
  const data = sheet.getDataRange().getValues();
  const eventsByDate = groupEventsByDate(data);

  for (const dateKey of Object.keys(eventsByDate).sort()) {
    const events = eventsByDate[dateKey];
    Logger.log(`\n📅 ${dateKey} (${events.length} event(s)):`);

    for (const event of events) {
      Logger.log(`   • ${event.clubName} - ${event.eventType} @ ${event.eventTime || 'TBD'}`);
      if (event.location) Logger.log(`     Location: ${event.location}`);
    }
  }

  Logger.log(`\n=== END TEST ===`);
}

/**
 * Force resync all events (delete and recreate)
 */
function forceResyncAll() {
  Logger.log('Force resyncing all events...');
  deleteAllSyncedEvents();
  syncEventsToCalendar();
}
