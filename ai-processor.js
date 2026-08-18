// Claude AI processor module for extracting meeting information from posts
import Anthropic from '@anthropic-ai/sdk';
import { retryWithBackoff } from './utils/retry.js';
import { emit } from './utils/progress-events.js';
import { validateClaudeResponse, validateMultiDayResponse } from './schemas/claude-response.js';

// Default Claude model - can be overridden via CLAUDE_MODEL env var
const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5';
// Haiku model for simpler posts (text-heavy, fewer images) - override via HAIKU_MODEL env var
const DEFAULT_HAIKU_MODEL = 'claude-haiku-4-5';

// Sonnet 5 runs adaptive thinking by default, and max_tokens caps thinking plus
// response together. This is fixed-schema JSON extraction, so thinking buys nothing
// and would eat the output budget - turn it off. Haiku 4.5 has no adaptive thinking
// and rejects the effort parameter, so it gets no extra params at all.
// Read env lazily so this does not depend on ai-processor.js being imported
// after dotenv.config() has run
export function getConfiguredModels() {
  return {
    sonnet: process.env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL,
    haiku: process.env.HAIKU_MODEL || DEFAULT_HAIKU_MODEL
  };
}

/**
 * Reports what a Claude call cost so the dashboard can keep a running spend
 * estimate. Uses the model the API says answered, not the one we asked for, so
 * an alias like claude-sonnet-5 is priced as the snapshot it resolved to.
 */
function reportUsage(message, requestedModel) {
  const usage = message.usage || {};
  emit('claude:usage', {
    model: message.model || requestedModel,
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    cacheReadTokens: usage.cache_read_input_tokens || 0,
    cacheWriteTokens: usage.cache_creation_input_tokens || 0
  });
}

export function modelParams(claudeModel) {
  if (claudeModel.startsWith('claude-haiku')) {
    return {};
  }
  return { thinking: { type: 'disabled' } };
}

// Maximum number of carousel images to process (saves tokens)
const MAX_CAROUSEL_IMAGES = parseInt(process.env.MAX_CAROUSEL_IMAGES || '3', 10);
// Maximum images for multi-day second pass (fetch all)
const MAX_MULTIDAY_IMAGES = 15;

/**
 * Initializes the Anthropic Claude API client
 * @param {string} apiKey - Anthropic API key
 * @returns {Anthropic} - Initialized Anthropic client instance
 */
export function initializeClaude(apiKey) {
  try {
    console.log('Initializing Claude AI client...');
    const anthropic = new Anthropic({
      apiKey: apiKey
    });
    console.log('Claude AI client initialized successfully');
    return anthropic;
  } catch (error) {
    console.error('Error initializing Claude client:', error.message);
    throw new Error(`Failed to initialize Claude client: ${error.message}`);
  }
}

/**
 * Fetches an image from a URL using Playwright (to handle authentication/CORS)
 * and converts it to base64 for Claude API
 * @param {Page} page - Playwright page object (for authenticated requests)
 * @param {string} imageUrl - URL of the image to fetch
 * @returns {Promise<string|null>} - Base64-encoded image string or null if failed
 */
async function fetchImageAsBase64(page, imageUrl) {
  if (!imageUrl) {
    return null;
  }

  try {
    return await retryWithBackoff(async () => {
      console.log(`Fetching image from: ${imageUrl.substring(0, 50)}...`);

      // With a browser, go through Playwright's request context so Instagram auth
      // cookies come along. Without one (Apify backend), the CDN URLs are signed
      // and publicly readable, so a plain fetch works - but they expire, which is
      // why images are fetched at processing time rather than cached.
      let buffer;
      let contentType;

      if (page) {
        const response = await page.request.get(imageUrl);

        if (!response.ok()) {
          const error = new Error(`Failed to fetch image: ${response.status()}`);
          error.status = response.status();
          throw error;
        }

        buffer = await response.body();
        contentType = response.headers()['content-type'] || 'image/jpeg';
      } else {
        const response = await fetch(imageUrl);

        if (!response.ok) {
          const error = new Error(
            `Failed to fetch image: ${response.status}` +
            (response.status === 403 ? ' (signed CDN URL may have expired)' : '')
          );
          error.status = response.status;
          throw error;
        }

        buffer = Buffer.from(await response.arrayBuffer());
        contentType = response.headers.get('content-type') || 'image/jpeg';
      }

      // Return in data URL format: data:image/jpeg;base64,{base64}
      return `data:${contentType};base64,${buffer.toString('base64')}`;
    }, {
      maxRetries: 2, // Fewer retries for image fetching
      initialDelay: 1000
    });
  } catch (error) {
    console.warn(`Error fetching image after retries: ${error.message}`);
    return null;
  }
}

/**
 * Determines whether to use Haiku (simpler/cheaper) or Sonnet (more capable) for a post
 * Uses Haiku when the post has clear text patterns and doesn't need complex image analysis
 * @param {Object} post - Post object containing caption and other data
 * @param {number} imageCount - Number of images successfully fetched
 * @returns {boolean} - True if Haiku should be used, false for Sonnet
 */
function selectModelForPost(post, imageCount) {
  // Allow forcing a specific model via env var
  if (process.env.FORCE_MODEL === 'haiku') return true;
  if (process.env.FORCE_MODEL === 'sonnet') return false;

  const caption = post.caption || '';
  const captionLength = caption.length;

  // ALWAYS use Sonnet for carousel posts (multiple images = flyers needing OCR)
  if (imageCount >= 2) {
    return false; // Use Sonnet for carousels
  }

  // ALWAYS use Sonnet if caption is very short (info is likely in image)
  if (captionLength < 50 && imageCount > 0) {
    return false; // Short caption + image = need OCR
  }

  // Patterns that indicate clear, extractable information in the caption
  const hasDatePattern = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}/i.test(caption);
  const hasTimePattern = /\b\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.)|lunch|after\s*school|before\s*school/i.test(caption);
  const hasLocationPattern = /\b(room|rm)\s*[a-z]?\d+|b\d+|c\d+|e\d+|p\d+|m\d+|horseshoe|btq|cafeteria|library|gym|auditorium/i.test(caption);

  // Count how many clear patterns are present
  const patternScore = (hasDatePattern ? 1 : 0) + (hasTimePattern ? 1 : 0) + (hasLocationPattern ? 1 : 0);

  // Use Haiku only if caption has clear, extractable patterns
  // AND we don't need to rely heavily on image OCR
  if (imageCount === 0 && captionLength > 50) {
    return true; // Text-only posts with decent captions
  }

  if (captionLength > 300 && patternScore >= 2) {
    return true; // Very detailed captions with multiple clear patterns
  }

  if (captionLength > 150 && patternScore >= 3) {
    return true; // Good captions with all patterns present
  }

  // Default to Sonnet for better OCR and extraction
  return false;
}

/**
 * Processes an Instagram post with Claude AI to extract meeting information
 * Handles both single-image posts and carousel posts with multiple slides
 * @param {Anthropic} anthropic - Initialized Anthropic client
 * @param {Object} post - Post object containing postUrl, imageUrls (array), caption, accountName, postDate
 * @param {Page} page - Playwright page object (for authenticated image fetching)
 * @returns {Promise<Object>} - Structured data object with extracted meeting information
 */
export async function processPostWithClaude(anthropic, post, page) {
  try {
    console.log(`Processing post from @${post.accountName}...`);

    // Get current year for dynamic date handling
    const currentYear = new Date().getFullYear();

    // Build the prompt - optimized for efficiency, comprehensiveness, and failsafe extraction
    const prompt = `Extract event information from this school club Instagram post. The post may contain multiple carousel images and a caption.

EXTRACTION PROCESS:
1. Use OCR to read ALL text from ALL images in the carousel
2. Combine OCR results with the caption text
3. Extract structured data using the rules below
4. Detect if this is a MULTI-DAY event (like Spirit Week with different themes each day)

REQUIRED OUTPUT (JSON format only, no explanation):
{
  "event_date": "YYYY-MM-DD or null",
  "event_time": "time string or null",
  "event_type": "type string or null",
  "location": "location string or null",
  "description": "one sentence or null",
  "confidence": 0.0-1.0,
  "is_multi_day": true/false,
  "detected_days": number or null
}

MULTI-DAY DETECTION:
Set is_multi_day to TRUE if the post contains:
- Multiple different dates (e.g., "Monday Feb 10, Tuesday Feb 11...")
- Spirit Week with different themes per day
- Multiple numbered days (e.g., "Day 1: Pajama, Day 2: Twin...")
- Keywords: "spirit week", "theme week", "all week", "dress up days"
- Multiple day names with different activities

If is_multi_day is true:
- Set detected_days to the number of UNIQUE days with distinct themes/activities
- Do NOT count summary slides, promotional slides, or "see you there" messages as separate days
- Example: A 5-day Spirit Week post with slides for Mon-Fri themes + a summary slide = 5 days (not 6)
- For event_date, use the FIRST day's date
- For description, mention it's a multi-day event

EXTRACTION RULES:

DATE (event_date):
- Format: YYYY-MM-DD (e.g., "${currentYear}-11-15")
- Current year: ${currentYear} (use for dates without year specified)
- Priority: Image OCR → Caption → Post date inference
- Relative date handling (use post date from context section):
  * "TMR", "tomorrow", "tmr" → post_date + 1 day
  * "next [day]" → calculate next occurrence after post date
  * "this [day]" → find this week's occurrence from post date
  * "Monday", "Tuesday", etc. without context → infer from post date
- Partial dates: If only month/day found (e.g., "Nov 15"), use year from post date or ${currentYear}
- Fallback: If no explicit/specific date is found, leave event_date as null and lower the confidence (≤ 0.4)
- Only infer from relative terms when there is clear context (otherwise prefer null)

TIME (event_time):
- Standardize to: "Lunch", "After School", or specific time (e.g., "3:30 PM", "11:59 PM")
- Variations to normalize:
  * "during lunch", "at lunch", "lunch time", "lunchtime" → "Lunch"
  * "after school", "afterschool", "after-school" → "After School"
  * "before school", "before-school" → "Before School"
- Preserve exact times if specified (include AM/PM)
- If no time clues appear anywhere, leave null and lower confidence

EVENT TYPE (event_type):
- Valid values: "Club Meeting", "Fundraiser", "Volunteer", "Social Event", "Announcement", "Competition", "Workshop", "Game", "Tryout", "Dance", "Assembly", "Election", "Activity", "Spirit Day", "Event", "Other"
- Infer from keywords:
  * Fundraiser: "fundraiser", "selling", "buy", "support", "donate"
  * Volunteer: "volunteer", "help", "community service"
  * Social Event: "party", "celebration", "social", "fun", "hangout"
  * Competition: "competition", "contest", "challenge", "tournament", "championship"
  * Workshop: "workshop", "learn", "tutorial", "training"
  * Announcement: "announcement", "reminder", "update", "news", "info"
  * Game: "game", "vs", "versus", "match", "away", "home game", "playoffs", "finals"
  * Tryout: "tryout", "try out", "tryouts", "audition"
  * Dance: "dance", "prom", "homecoming", "formal", "semi-formal", "rally"
  * Assembly: "assembly", "all-school", "school-wide", "pep rally"
  * Election: "election", "vote", "voting", "candidate", "campaign"
  * Activity: "activity", "event", "lunch activity"
  * Spirit Day: "spirit day", "spirit week", "dress up", "theme day"
  * Event: use for general school events that don't fit other categories
  * Club Meeting: default for club-related posts if no other type matches

LOCATION:
- Extract: Room numbers (B17, C13, E2A, P23, M3, etc.), building names, or named areas
- Common locations: "Horseshoe", "BTQ", "Cafeteria", "Library", "Gym", "Auditorium"
- Patterns: [Letter][Number], [Letter][Number][Letter], or full building names
- Check both image OCR and caption
- Return null only if no location mentioned

DESCRIPTION:
- One concise sentence summarizing the event
- Include key details: what, when (if not in date/time), where (if not in location)
- Maximum 100 words

CONFIDENCE:
- 0.9-1.0: All information clearly visible and unambiguous
- 0.7-0.9: Most information clear, minor ambiguity
- 0.5-0.7: Some information inferred or partially visible
- 0.3-0.5: Significant inference required
- 0.0-0.3: Very uncertain, minimal information available

VALIDATION:
- event_date: Must be valid YYYY-MM-DD or null
- event_time: Must be standardized format or null
- event_type: Must be one of the valid types or null
- confidence: Must be between 0.0 and 1.0
- When information cannot be located, return null instead of fabricating values

Return ONLY valid JSON with these exact keys. No markdown, no explanation, no additional text.`;
    
    // Prepare message content array for Claude API
    const content = [];

    // Fetch and include images (limited to MAX_CAROUSEL_IMAGES to save tokens)
    let imagesFetched = 0;
    const allImageUrls = post.imageUrls || (post.imageUrl ? [post.imageUrl] : []); // Support both old and new format
    const imageUrls = allImageUrls.slice(0, MAX_CAROUSEL_IMAGES); // Limit to first N images

    if (allImageUrls.length > MAX_CAROUSEL_IMAGES) {
      console.log(`  Limiting carousel images: using first ${MAX_CAROUSEL_IMAGES} of ${allImageUrls.length} images`);
    }

    if (imageUrls.length > 0) {
      const fetchResults = await Promise.all(
        imageUrls.map(async (imageUrl, index) => {
          const imageBase64 = await fetchImageAsBase64(page, imageUrl);
          return { index, imageBase64 };
        })
      );

      for (const { index, imageBase64 } of fetchResults) {
        if (imageBase64) {
          const base64Match = imageBase64.match(/^data:(image\/[^;]+);base64,(.+)$/);
          if (base64Match) {
            const mimeType = base64Match[1];
            const base64Data = base64Match[2];
            content.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: mimeType,
                data: base64Data
              }
            });
            imagesFetched++;
            console.log(`Image ${index + 1}/${imageUrls.length} successfully fetched and included in Claude request`);
          }
        } else {
          console.warn(`Failed to fetch image ${index + 1}/${imageUrls.length}`);
        }
      }

      if (imagesFetched === 0) {
        console.warn('Failed to fetch any images, proceeding with text only');
      }
    }
    
    // Add text prompt with caption and post date
    let textContent = prompt;
    
    // Add post date context for date inference
    if (post.postDate && typeof post.postDate === 'string' && post.postDate.trim()) {
      // Calculate reference dates
      const postDateObj = new Date(post.postDate + 'T00:00:00');
      
      // Validate the date is valid before using it
      if (!isNaN(postDateObj.getTime())) {
        const tomorrowDateObj = new Date(postDateObj);
        tomorrowDateObj.setDate(tomorrowDateObj.getDate() + 1);
        const tomorrowDate = tomorrowDateObj.toISOString().split('T')[0];
        
        // Get day of week for "next [day]" calculations
        const daysOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const postDayOfWeek = daysOfWeek[postDateObj.getDay()];
        const postYear = post.postDate.split('-')[0];
        
        textContent += `\n\n=== POST DATE REFERENCE ===
Post Published: ${post.postDate} (${postDayOfWeek})
Use this as the reference point for ALL relative date calculations.

Quick Reference:
- "TMR"/"tomorrow" → ${tomorrowDate}
- "next [day]" → Calculate next occurrence after ${post.postDate}
- Partial dates (e.g., "Nov 15") → Use year ${postYear}
- No date found → Leave meeting_date null (do not infer without explicit clues)
=== END POST DATE REFERENCE ===`;
      }
    }
    
    if (post.caption) {
      textContent += `\n\nCaption: ${post.caption}`;
    } else {
      textContent += `\n\nCaption: No caption available`;
    }
    
    // If no images were fetched but imageUrls exist, include URLs in text
    if (imageUrls.length > 0 && imagesFetched === 0) {
      textContent += `\n\nImage URLs: ${imageUrls.join(', ')} (Note: Could not fetch images, please extract info from caption)`;
    }
    
    content.push({
      type: 'text',
      text: textContent
    });
    
    // Select model based on post complexity
    // Use Haiku for simpler posts (text-heavy, clear patterns) to save tokens
    // Use Sonnet for complex posts (multiple images, needs OCR, short caption)
    const useHaiku = selectModelForPost(post, imagesFetched);
    const models = getConfiguredModels();
    const claudeModel = useHaiku ? models.haiku : models.sonnet;

    if (useHaiku) {
      console.log(`  Using Haiku model (simpler post detected)`);
    }

    // Make API call to Claude with retry logic
    const message = await retryWithBackoff(async () => {
      return await anthropic.messages.create({
        model: claudeModel,
        max_tokens: 1024,
        ...modelParams(claudeModel),
        messages: [
          {
            role: 'user',
            content: content
          }
        ]
      });
    }, {
      maxRetries: 3,
      initialDelay: 2000, // Longer initial delay for API calls
      maxDelay: 30000
    });
    reportUsage(message, claudeModel);

    // Extract text response from Claude
    if (!message.content || message.content.length === 0) {
      throw new Error('Empty response from Claude API');
    }
    
    const responseText = message.content[0].text;
    
    // Parse JSON response
    // Claude may include markdown code blocks, so we'll try to extract JSON
    let jsonText = responseText.trim();
    
    // Remove markdown code blocks if present
    if (jsonText.startsWith('```')) {
      // Extract content between ```json and ```
      const jsonMatch = jsonText.match(/```(?:json)?\n?(.*?)```/s);
      if (jsonMatch) {
        jsonText = jsonMatch[1].trim();
      }
    }
    
    // Parse the JSON
    const rawData = JSON.parse(jsonText);

    // Validate with Zod schema
    const extractedData = validateClaudeResponse(rawData);

    // Check if this is a multi-day event that needs second pass
    if (extractedData.is_multi_day && extractedData.detected_days > 1) {
      console.log(`  Multi-day event detected (${extractedData.detected_days} days) - performing second pass...`);

      // Second pass: fetch all images and extract all days
      const multiDayResults = await extractMultiDayEvents(anthropic, post, page, extractedData.detected_days, currentYear);

      // Add configurable delay between API calls
      const delayBetweenApiCalls = parseInt(process.env.DELAY_BETWEEN_API_CALLS_MS || '1000', 10);
      await new Promise(resolve => setTimeout(resolve, delayBetweenApiCalls));

      return multiDayResults; // Returns array of events
    }

    // Single event processing (original flow)
    let eventTime = extractedData.event_time || null;
    const eventType = extractedData.event_type || null;

    // Default event_time to "Lunch" for certain event types when not specified
    const lunchDefaultTypes = ['Club Meeting', 'Fundraiser', 'Workshop'];
    if (!eventTime && eventType && lunchDefaultTypes.includes(eventType)) {
      eventTime = 'Lunch';
      console.log(`  Defaulting event_time to "Lunch" for ${eventType}`);
    }

    const structuredData = {
      club_name: post.accountName || extractedData.club_name || null,
      event_date: extractedData.event_date || null,
      event_time: eventTime,
      event_type: eventType,
      location: extractedData.location || null,
      description: extractedData.description || null,
      confidence: extractedData.confidence || null,
      post_url: post.postUrl,
      posted_date: post.postDate || null,
      account_name: post.accountName
    };

    console.log(`Successfully processed post from @${post.accountName}`);

    // Add configurable delay between API calls to respect rate limits
    const delayBetweenApiCalls = parseInt(process.env.DELAY_BETWEEN_API_CALLS_MS || '1000', 10);
    await new Promise(resolve => setTimeout(resolve, delayBetweenApiCalls));

    return structuredData;
  } catch (error) {
    console.error(`Error processing post from @${post.accountName}:`, error.message);

    // Return structured data with null values and error info
    return {
      club_name: post.accountName || null,
      event_date: null,
      event_time: null,
      event_type: null,
      location: null,
      description: `Error processing post: ${error.message}`,
      confidence: 0.0,
      post_url: post.postUrl || null,
      posted_date: post.postDate || null,
      account_name: post.accountName || null,
      error: error.message
    };
  }
}

/**
 * Second pass extraction for multi-day events (Spirit Week, etc.)
 * Fetches all images and extracts each day as a separate event
 * @param {Anthropic} anthropic - Initialized Anthropic client
 * @param {Object} post - Post object
 * @param {Page} page - Playwright page for image fetching
 * @param {number} expectedDays - Number of days detected in first pass
 * @param {number} currentYear - Current year for date handling
 * @returns {Promise<Array>} - Array of event objects
 */
async function extractMultiDayEvents(anthropic, post, page, expectedDays, currentYear) {
  try {
    // Build multi-day extraction prompt
    const multiDayPrompt = `This is a MULTI-DAY event post (like Spirit Week). Extract EACH DAY as a separate event.

EXTRACTION PROCESS:
1. Use OCR to read ALL text from ALL images
2. Find each day's date and theme/activity
3. Return an array of events, one for each day

REQUIRED OUTPUT (JSON array format only, no explanation):
{
  "events": [
    {
      "event_date": "YYYY-MM-DD",
      "event_time": "time or null",
      "event_type": "Spirit Day/Activity/Event/etc.",
      "location": "location or null",
      "description": "Theme or activity for this day",
      "confidence": 0.0-1.0
    }
  ]
}

RULES:
- Current year: ${currentYear}
- Create ONE entry per UNIQUE day with a distinct theme or activity
- event_type should be "Spirit Day" for dress-up themes, "Activity" for lunch activities, "Event" for other
- description should include the theme (e.g., "Pajama Day", "Twin Day", "Jersey Day")
- If a day's date is unclear, infer from sequence (Monday, Tuesday, etc.)

IGNORE these slide types (do NOT create entries for them):
- Summary slides that recap all days
- Promotional slides ("Get ready for Spirit Week!")
- Final message slides ("See you there!", "Don't forget to participate!")
- Slides that repeat information from other slides
- Slides without a specific day's theme/activity

Return ONLY valid JSON. No markdown, no explanation.`;

    // Fetch ALL images for multi-day extraction
    const allImageUrls = post.imageUrls || (post.imageUrl ? [post.imageUrl] : []);
    const imageUrls = allImageUrls.slice(0, MAX_MULTIDAY_IMAGES);

    console.log(`  Fetching ${imageUrls.length} images for multi-day extraction...`);

    const content = [];

    // Fetch all images
    if (imageUrls.length > 0) {
      const fetchResults = await Promise.all(
        imageUrls.map(async (imageUrl, index) => {
          const imageBase64 = await fetchImageAsBase64(page, imageUrl);
          return { index, imageBase64 };
        })
      );

      let imagesFetched = 0;
      for (const { index, imageBase64 } of fetchResults) {
        if (imageBase64) {
          const base64Match = imageBase64.match(/^data:(image\/[^;]+);base64,(.+)$/);
          if (base64Match) {
            content.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: base64Match[1],
                data: base64Match[2]
              }
            });
            imagesFetched++;
          }
        }
      }
      console.log(`  ${imagesFetched}/${imageUrls.length} images fetched for second pass`);
    }

    // Add text prompt
    let textContent = multiDayPrompt;

    if (post.postDate) {
      textContent += `\n\nPost published: ${post.postDate} (use as reference for date calculations)`;
    }

    if (post.caption) {
      textContent += `\n\nCaption: ${post.caption}`;
    }

    content.push({ type: 'text', text: textContent });

    // Make API call with Sonnet (always use best model for multi-day)
    const claudeModel = getConfiguredModels().sonnet;
    const message = await retryWithBackoff(async () => {
      return await anthropic.messages.create({
        model: claudeModel,
        max_tokens: 2048, // More tokens for multi-day response
        ...modelParams(claudeModel),
        messages: [{ role: 'user', content: content }]
      });
    }, {
      maxRetries: 3,
      initialDelay: 2000,
      maxDelay: 30000
    });
    reportUsage(message, claudeModel);

    if (!message.content || message.content.length === 0) {
      throw new Error('Empty response from Claude API (multi-day)');
    }

    // Parse response
    let jsonText = message.content[0].text.trim();
    if (jsonText.startsWith('```')) {
      const jsonMatch = jsonText.match(/```(?:json)?\n?(.*?)```/s);
      if (jsonMatch) jsonText = jsonMatch[1].trim();
    }

    const rawData = JSON.parse(jsonText);
    const validatedData = validateMultiDayResponse(rawData);

    if (!validatedData.events || validatedData.events.length === 0) {
      console.warn(`  Multi-day extraction returned no events, falling back to single event`);
      return createFallbackEvent(post, 'Multi-day event (extraction failed)', true);
    }

    // Check if we got fewer events than expected
    const needsReview = validatedData.events.length < expectedDays;
    if (needsReview) {
      console.warn(`  ⚠️ Expected ${expectedDays} days but only extracted ${validatedData.events.length} - flagging for review`);
    }

    // Convert to structured data array
    const results = validatedData.events.map((event, index) => {
      let eventTime = event.event_time || null;
      const eventType = event.event_type || 'Spirit Day';

      // Default to Lunch for Spirit Days without time
      if (!eventTime && ['Spirit Day', 'Activity'].includes(eventType)) {
        eventTime = null; // Spirit days are typically all-day
      }

      return {
        club_name: post.accountName || null,
        event_date: event.event_date || null,
        event_time: eventTime,
        event_type: eventType,
        location: event.location || null,
        description: event.description || null,
        confidence: event.confidence || 0.7,
        post_url: post.postUrl,
        posted_date: post.postDate || null,
        account_name: post.accountName,
        needs_review: needsReview && index === 0 // Flag first event for review
      };
    });

    console.log(`  Successfully extracted ${results.length} events from multi-day post`);
    return results;

  } catch (error) {
    console.error(`  Error in multi-day extraction: ${error.message}`);
    return createFallbackEvent(post, `Multi-day event (error: ${error.message})`, true);
  }
}

/**
 * Creates a fallback single event when multi-day extraction fails
 */
function createFallbackEvent(post, description, needsReview = false) {
  return [{
    club_name: post.accountName || null,
    event_date: null,
    event_time: null,
    event_type: 'Event',
    location: null,
    description: description,
    confidence: 0.3,
    post_url: post.postUrl,
    posted_date: post.postDate || null,
    account_name: post.accountName,
    needs_review: needsReview
  }];
}

