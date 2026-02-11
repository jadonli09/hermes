# Google Apps Script: Calendar Sync

Automatically syncs events from your spreadsheet to Google Calendar.

**Creates ONE all-day event per date** with all club events listed in the description.
Excludes Announcements - only includes Club Meetings, Fundraisers, Workshops, Social Events, etc.

## Setup Instructions

### Step 1: Open Apps Script Editor
1. Open your Google Spreadsheet
2. Go to **Extensions > Apps Script**
3. Delete any existing code in the editor

### Step 2: Add the Script
1. Copy the entire contents of `CalendarSync.gs`
2. Paste it into the Apps Script editor
3. Click **Save** (Ctrl+S / Cmd+S)

### Step 3: Authorize the Script
1. Click **Run > syncEventsToCalendar**
2. Click "Review Permissions"
3. Select your Google account
4. Click "Advanced" > "Go to [project name]"
5. Click "Allow"

### Step 4: Set Up Automatic Trigger
Run one of these functions ONCE to enable automatic syncing:

| Function | Frequency |
|----------|-----------|
| `setupTrigger()` | Every hour |
| `setupFrequentTrigger()` | Every 30 minutes |
| `setupDailyTrigger()` | Daily at 6 AM |

To run: Select the function from the dropdown, then click **Run**

## How It Works

### Daily All-Day Events
- Groups all events by date
- Creates ONE all-day event per date titled "Club Events (X)"
- Lists all events in the description with details

### Example Calendar Event
```
Title: Club Events (3)
Type: All-day event

Description:
━━━━━━━━━━━━━━━━━━━━
📌 Chess Club
   Type: Club Meeting
   Time: 🍽️ Lunch (12:40-1:15 PM)
   Location: B17
   Details: Weekly chess meeting

━━━━━━━━━━━━━━━━━━━━
📌 Environmental Club
   Type: Fundraiser
   Time: 🏫 After School (3:11-4:00 PM)
   Location: Horseshoe
   Details: Plant sale fundraiser
...
```

### Filtering
Events are **excluded** if:
- Event type is "Announcement"
- No event date
- No club name
- Confidence below 0.3

### Time Display
| Spreadsheet Value | Displayed As |
|-------------------|--------------|
| "Lunch" | 🍽️ Lunch (12:40-1:15 PM) |
| "After School" | 🏫 After School (3:11-4:00 PM) |
| "Before School" | 🌅 Before School (7:45-8:30 AM) |
| "3:30 PM" | 🕐 3:30 PM |

## Functions Reference

| Function | Description |
|----------|-------------|
| `syncEventsToCalendar()` | Main sync - creates/updates daily events |
| `testSync()` | Preview what would sync (no changes made) |
| `setupTrigger()` | Enable hourly auto-sync |
| `setupFrequentTrigger()` | Enable 30-minute auto-sync |
| `setupDailyTrigger()` | Enable daily auto-sync |
| `removeTriggers()` | Disable auto-sync |
| `deleteAllSyncedEvents()` | Delete all synced calendar events |
| `clearSyncTimestamps()` | Reset sync status (force re-sync) |
| `forceResyncAll()` | Delete all and recreate from scratch |

## Spreadsheet Column Layout

| Column | Field | Used For |
|--------|-------|----------|
| A | Club Name | Event listing |
| B | Event Date | Grouping by date |
| C | Event Time | Display in description |
| D | Event Type | Filtering + display |
| E | Location | Display in description |
| F | Post URL | Source link in description |
| G | Posted Date | (not used) |
| H | Confidence | Filtering (min 0.3) |
| I | Description | Display in description |
| J | Last Updated | (not used) |
| K | Calendar Synced | Sync timestamp (auto-added) |

## Troubleshooting

### "Calendar not found"
- Verify the calendar ID in CONFIG
- Make sure you have access to the calendar

### Events not syncing
- Run `testSync()` to preview what would sync
- Check the **Execution log** (View > Execution log)
- Verify event dates are valid

### Duplicate daily events
- Run `forceResyncAll()` to delete all and recreate

### Trigger not running
- Check **Triggers** (clock icon in left sidebar)
- Make sure a trigger exists for `syncEventsToCalendar`
