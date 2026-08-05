# Hermes - Instagram Club Scraper

An automated Node.js application that scrapes Instagram posts from 80+ school club accounts, processes them with Claude AI to extract meeting information, and populates a Google Sheets spreadsheet.

## Project Description

This application automates the collection of meeting information from school club Instagram accounts by:
1. **Scraping** Instagram posts from multiple club accounts using Playwright with smart date range filtering
2. **Processing** each post with Claude AI (Claude Sonnet 5, or Claude Haiku 4.5 for simpler text-only posts) to extract structured meeting data from both images and captions
3. **Populating** a Google Sheets spreadsheet with the extracted information, automatically sorted by date
4. **Deduplicating** posts by URL to avoid processing the same post twice
5. **Tracking progress** to enable resuming interrupted runs

## Current Project State

✅ **Fully Functional** - The application is production-ready with the following features:
- Date range filtering with early termination (only processes posts within specified date range)
- Duplicate detection and deduplication
- Progress tracking and resume capability
- Retry logic with exponential backoff for network failures
- Smart filtering of intro/pinned posts
- Configurable via environment variables
- Handles Instagram rate limiting and blocking detection
- Updates existing spreadsheet rows when data changes
- Supports carousel posts with multiple images

## Prerequisites

- **Node.js** (version 16 or higher recommended)
- **npm** (comes with Node.js)
- An **Instagram account** with login credentials
- An **Anthropic API key** (for Claude AI)
- A **Google Cloud project** with Google Sheets API enabled and service account credentials

## Installation

### 1. Install Dependencies

Run the following command to install all required npm packages:

```bash
npm install
```

### 2. Install Playwright Browser

Install the Chromium browser for Playwright:

```bash
npx playwright install chromium
```

This will download the Chromium browser binary required for web scraping.

## Configuration

### 1. Environment Variables

Copy the example environment file and fill in your credentials:

```bash
cp .env.example .env
```

Edit `.env` and add your credentials:

```env
# Required: Instagram credentials
INSTAGRAM_USERNAME=your_instagram_username
INSTAGRAM_PASSWORD=your_instagram_password

# Required: Anthropic API key for Claude AI
ANTHROPIC_API_KEY=sk-ant-your_anthropic_api_key_here

# Required: Google Spreadsheet ID
GOOGLE_SPREADSHEET_ID=your_google_spreadsheet_id_here

# Required: Date range for scraping (YYYY-MM-DD format)
START_DATE=2025-01-01
END_DATE=2025-12-31

# Optional: Configuration settings
HEADLESS_MODE=false                    # Set to 'true' to run browser in headless mode
MAX_CLUBS_TO_PROCESS=5                 # Number of clubs to process per run (default: 5)
MAX_POSTS_PER_CLUB=10                  # Maximum posts to scrape per club (default: 10)
MAX_SCROLLS_PER_CLUB=10                # Maximum scrolls per club profile (default: 10)
MAX_CONSECUTIVE_OLD_POSTS=3            # Stop early after N consecutive posts older than START_DATE (default: 3)
RESUME=false                            # Set to 'true' to resume from previous run
RETRY_FAILED_CLUBS=false               # Set to 'true' to retry clubs that failed in previous runs
TEST_CLUB=                             # Process only a specific club (e.g., "msjbio")
DELAY_BETWEEN_CLUBS_MS=3000            # Delay between processing clubs (default: 3000ms)
DELAY_AFTER_LOGIN_MS=3000              # Delay after Instagram login (default: 3000ms)
DELAY_POST_LOAD_MS=2000                 # Delay after loading post page (default: 2000ms)
DELAY_PROFILE_LOAD_MS=3000              # Delay after loading profile page (default: 3000ms)
DELAY_BETWEEN_API_CALLS_MS=1000        # Delay between Claude API calls (default: 1000ms)
ENABLE_DATE_FIRST_FILTERING=true       # Enable date filtering before full extraction (default: true)
```

### 2. Get Anthropic API Key

1. Visit [Anthropic's Console](https://console.anthropic.com/)
2. Sign up or log in to your account
3. Navigate to **API Keys** section
4. Click **Create Key**
5. Copy the API key (starts with `sk-ant-`)
6. Paste it into your `.env` file as `ANTHROPIC_API_KEY`

**Note:** Keep your API key secure and never commit it to version control.

### 3. Setup Google Sheets API

#### Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable the **Google Sheets API**:
   - Navigate to **APIs & Services** > **Library**
   - Search for "Google Sheets API"
   - Click **Enable**

#### Create a Service Account

1. Go to **APIs & Services** > **Credentials**
2. Click **Create Credentials** > **Service Account**
3. Fill in the service account details
4. Click **Create and Continue**
5. Skip the optional steps and click **Done**

#### Generate Service Account Key

1. Click on the newly created service account
2. Go to the **Keys** tab
3. Click **Add Key** > **Create New Key**
4. Select **JSON** format
5. Download the JSON file
6. Save it as `google-credentials.json` in the project root directory

#### Share Google Spreadsheet with Service Account

1. Open your Google Spreadsheet (or create a new one)
2. Click **Share** button
3. Add the service account email (found in `google-credentials.json` as `client_email`)
4. Give it **Editor** permissions
5. Copy the Spreadsheet ID from the URL:
   - URL format: `https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit`
   - Paste the `SPREADSHEET_ID` into your `.env` file

### 4. Configure Club Accounts

Edit `clubs.json` to include the Instagram usernames of the clubs you want to scrape:

```json
{
  "clubs": [
    "club_username_1",
    "club_username_2",
    "club_username_3"
  ]
}
```

**Note:** Only include the username, not the full URL (e.g., use `msjbio`, not `@msjbio` or `instagram.com/msjbio`).

## Running the Application

Once everything is configured, run the application:

```bash
node main.js
```

Or use npm:

```bash
npm start
```

The application will:
1. Launch a browser window (configurable via `HEADLESS_MODE` environment variable)
2. Log into Instagram
3. Load existing post URLs from spreadsheet for deduplication
4. Process clubs (randomly selected, configurable via `MAX_CLUBS_TO_PROCESS`)
5. For each club:
   - Scrape posts within the specified date range (`START_DATE` to `END_DATE`)
   - Filter out duplicates and intro/pinned posts
   - Extract post data (images and captions)
   - Process each post with Claude AI to extract meeting information
6. Update or append results to Google Sheets
7. Sort the spreadsheet by meeting date

### Resume Mode

If a run is interrupted, you can resume from where it left off:

```bash
RESUME=true node main.js
```

This will:
- Skip clubs that were already successfully processed
- Skip posts that were already processed
- Continue from where the previous run stopped
- Save progress after each club/post for safety

### Processing Specific Clubs

To process only a specific club for testing:

```bash
TEST_CLUB=msjbio node main.js
```

### Date Range Filtering

The application only processes posts within the date range specified by `START_DATE` and `END_DATE`. It uses smart early termination to stop scrolling once it finds consecutive posts older than `START_DATE`, improving efficiency.

## File Structure

```
hermes/
├── main.js                 # Main orchestrator that coordinates all modules
├── scraper.js              # Instagram scraper using Playwright
├── ai-processor.js         # Claude AI processor for extracting meeting info
├── sheets-writer.js        # Google Sheets writer module
├── clubs.json              # List of Instagram club usernames to scrape (80+ clubs)
├── utils/
│   ├── progress.js         # Progress tracking and resume functionality
│   └── retry.js            # Retry utility with exponential backoff
├── .env                    # Environment variables (not in git)
├── .env.example            # Example environment variables template
├── .gitignore              # Git ignore file
├── google-credentials.json # Google service account credentials (not in git)
├── progress.json           # Progress tracking file (created automatically, not in git)
├── run-log.json            # Run statistics log (created automatically)
├── package.json            # Node.js dependencies and project config
└── README.md               # This file
```

### File Descriptions

- **main.js**: Orchestrates the entire process - launches browser, logs in, processes clubs, writes to sheets, handles progress tracking
- **scraper.js**: Contains functions for logging into Instagram, scraping posts from club accounts, date filtering, and duplicate detection
- **ai-processor.js**: Handles Claude AI integration for extracting structured meeting data from posts (supports carousel posts with multiple images)
- **sheets-writer.js**: Manages Google Sheets authentication, writing/sorting data, and update/append logic
- **clubs.json**: Configuration file containing list of Instagram club usernames (currently 80+ clubs)
- **utils/progress.js**: Progress tracking functionality for resume capability
- **utils/retry.js**: Retry logic with exponential backoff for handling transient failures
- **.env**: Your personal credentials and configuration (never commit this to git)
- **progress.json**: Automatically created to track progress for resume functionality
- **run-log.json**: Automatically created with statistics from each run

## Output Format

The application extracts the following information from each post and writes it to Google Sheets:

### Spreadsheet Columns

1. **club_name**: Name of the club (from Instagram account)
2. **meeting_date**: Date in YYYY-MM-DD format (extracted from post images/caption)
3. **meeting_time**: Specific time (e.g., "3:30 PM") or standardized values ("Lunch", "After School", "Before School")
4. **meeting_type**: One of: "Club Meeting", "Fundraiser", "Volunteer", "Social Event", "Announcement", "Competition", "Workshop", or "Other"
5. **location**: Room number (e.g., "B17", "C13") or location name (e.g., "Horseshoe", "Library")
6. **post_url**: Link to the original Instagram post (used for deduplication)
7. **posted_date**: Date when the post was published on Instagram
8. **confidence**: Confidence score (0.0-1.0) indicating extraction reliability
9. **description**: One-sentence description of the meeting/event
10. **last_updated**: Timestamp of when the row was last updated
11. **recurrence**: Recurrence pattern if detected (e.g., "Every Monday", "Weekly", "Bi-weekly", "Monthly")

### Data Processing Features

- **Duplicate Detection**: Posts are deduplicated by `post_url` to avoid processing the same post twice
- **Update vs Append**: If a post URL already exists in the spreadsheet, the row is updated only if data has changed
- **Date Filtering**: Only posts within the specified date range (`START_DATE` to `END_DATE`) are processed
- **Early Termination**: Stops scrolling when it finds consecutive posts older than `START_DATE` to improve efficiency
- **Intro Post Filtering**: Automatically filters out intro/pinned posts that don't contain meeting information

## Troubleshooting

### Instagram Login Issues

- Make sure your credentials are correct in `.env`
- Instagram may require 2FA verification - you may need to use an app password
- If you see rate limiting, wait a few minutes and try again

### Claude API Errors

- Verify your API key is correct and has sufficient credits
- Check Anthropic's status page if you see API errors
- Rate limits: The application includes delays to respect API limits

### Google Sheets Issues

- Ensure the service account email has Editor access to the spreadsheet
- Verify `google-credentials.json` is in the project root
- Check that Google Sheets API is enabled in your Google Cloud project

### Playwright Issues

- Run `npx playwright install chromium` again if browser launch fails
- Make sure you have sufficient disk space for the browser binary

## Advanced Configuration

### Processing All Clubs

By default, the application processes a random subset of clubs (configurable via `MAX_CLUBS_TO_PROCESS`). To process all clubs, set a high value:

```bash
MAX_CLUBS_TO_PROCESS=100 node main.js
```

### Adjusting Post Limits

Control how many posts are scraped per club:

```bash
MAX_POSTS_PER_CLUB=20 MAX_SCROLLS_PER_CLUB=15 node main.js
```

### Date Range Configuration

Set specific date ranges for scraping:

```bash
START_DATE=2025-01-15 END_DATE=2025-02-15 node main.js
```

### Headless Mode

Run without opening a browser window:

```bash
HEADLESS_MODE=true node main.js
```

### Rate Limiting

The application includes built-in delays to respect Instagram and API rate limits. Adjust delays if needed:

```bash
DELAY_BETWEEN_CLUBS_MS=5000 DELAY_BETWEEN_API_CALLS_MS=2000 node main.js
```

## Features

- ✅ **Smart Date Filtering**: Only processes posts within specified date range with early termination
- ✅ **Duplicate Detection**: Automatically skips posts that already exist in the spreadsheet
- ✅ **Progress Tracking**: Save and resume interrupted runs
- ✅ **Retry Logic**: Automatic retries with exponential backoff for transient failures
- ✅ **Instagram Blocking Detection**: Detects and handles rate limits and challenges
- ✅ **Carousel Support**: Processes multi-image carousel posts
- ✅ **OCR Integration**: Extracts text from images using Claude AI's vision capabilities
- ✅ **Update Logic**: Updates existing rows when data changes instead of creating duplicates
- ✅ **Configurable**: Extensive environment variable configuration
- ✅ **Error Handling**: Comprehensive error handling with graceful degradation

## Security Notes

- Never commit `.env` or `google-credentials.json` to version control
- Keep your API keys secure
- Use environment variables for sensitive data
- Regularly rotate your credentials
- The `.gitignore` file is configured to exclude sensitive files

## License

ISC

## Support

For issues or questions, please check:
- Playwright documentation: https://playwright.dev/
- Anthropic API docs: https://docs.anthropic.com/
- Google Sheets API docs: https://developers.google.com/sheets/api




