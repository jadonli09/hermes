// Claude AI processor module for extracting meeting information from posts
import Anthropic from '@anthropic-ai/sdk';
import { retryWithBackoff } from './utils/retry.js';

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
      
      // Use Playwright's request context to fetch image (includes Instagram auth cookies)
      const response = await page.request.get(imageUrl);
      
      if (!response.ok()) {
        const error = new Error(`Failed to fetch image: ${response.status()}`);
        error.status = response.status();
        throw error;
      }
      
      // Get image as buffer
      const buffer = await response.body();
      
      // Determine MIME type from response headers or URL
      const contentType = response.headers()['content-type'] || 'image/jpeg';
      
      // Convert buffer to base64
      const base64Image = buffer.toString('base64');
      
      // Return in data URL format: data:image/jpeg;base64,{base64}
      return `data:${contentType};base64,${base64Image}`;
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
    
    // Build the prompt - optimized for efficiency, comprehensiveness, and failsafe extraction
    const prompt = `Extract meeting information from this school club Instagram post. The post may contain multiple carousel images and a caption.

EXTRACTION PROCESS:
1. Use OCR to read ALL text from ALL images in the carousel
2. Combine OCR results with the caption text
3. Extract structured data using the rules below

REQUIRED OUTPUT (JSON format only, no explanation):
{
  "meeting_date": "YYYY-MM-DD or null",
  "meeting_time": "time string or null",
  "meeting_type": "type string or null",
  "location": "location string or null",
  "description": "one sentence or null",
  "confidence": 0.0-1.0,
  "recurrence": "recurrence pattern string or null"
}

EXTRACTION RULES:

DATE (meeting_date):
- Format: YYYY-MM-DD (e.g., "2025-11-15")
- Current year: 2025 (use for dates without year specified)
- Priority: Image OCR → Caption → Post date inference
- Relative date handling (use post date from context section):
  * "TMR", "tomorrow", "tmr" → post_date + 1 day
  * "next [day]" → calculate next occurrence after post date
  * "this [day]" → find this week's occurrence from post date
  * "Monday", "Tuesday", etc. without context → infer from post date
- Partial dates: If only month/day found (e.g., "Nov 15"), use year from post date or 2025
- Fallback: If no explicit/specific date is found, leave meeting_date as null and lower the confidence (≤ 0.4)
- Only infer from relative terms when there is clear context (otherwise prefer null)

TIME (meeting_time):
- Standardize to: "Lunch", "After School", or specific time (e.g., "3:30 PM", "11:59 PM")
- Variations to normalize:
  * "during lunch", "at lunch", "lunch time", "lunchtime" → "Lunch"
  * "after school", "afterschool", "after-school" → "After School"
  * "before school", "before-school" → "Before School"
- Preserve exact times if specified (include AM/PM)
- If no time clues appear anywhere, leave null and lower confidence

MEETING TYPE (meeting_type):
- Valid values: "Club Meeting", "Fundraiser", "Volunteer", "Social Event", "Announcement", "Competition", "Workshop", "Other"
- Infer from keywords:
  * Fundraiser: "fundraiser", "selling", "buy", "support", "donate"
  * Volunteer: "volunteer", "help", "community service"
  * Social Event: "party", "celebration", "social", "fun"
  * Competition: "competition", "contest", "challenge", "tournament"
  * Workshop: "workshop", "learn", "tutorial", "training"
  * Announcement: "announcement", "reminder", "update", "news"
  * Club Meeting: default if no other type matches

LOCATION:
- Extract: Room numbers (B17, C13, E2A, P23, M3, etc.), building names, or named areas
- Common locations: "Horseshoe", "BTQ", "Cafeteria", "Library", "Gym", "Auditorium"
- Patterns: [Letter][Number], [Letter][Number][Letter], or full building names
- Check both image OCR and caption
- Return null only if no location mentioned

DESCRIPTION:
- One concise sentence summarizing the meeting/event
- Include key details: what, when (if not in date/time), where (if not in location)
- Maximum 100 words

CONFIDENCE:
- 0.9-1.0: All information clearly visible and unambiguous
- 0.7-0.9: Most information clear, minor ambiguity
- 0.5-0.7: Some information inferred or partially visible
- 0.3-0.5: Significant inference required
- 0.0-0.3: Very uncertain, minimal information available

RECURRENCE (recurrence):
- Detect if the meeting is recurring (happens regularly)
- Look for patterns in text:
  * "every [day]" → "Every Monday", "Every Tuesday", "Every Wednesday", etc.
  * "weekly" → "Weekly"
  * "bi-weekly" or "biweekly" → "Bi-weekly"
  * "monthly" → "Monthly"
  * "recurring", "regular meeting", "regularly" → "Recurring"
  * "every week", "each week" → "Weekly"
  * "every other week" → "Bi-weekly"
- If specific day mentioned with "every" (e.g., "every Monday at lunch"), return "Every Monday"
- If only frequency mentioned (e.g., "weekly meetings"), return "Weekly"
- If no recurring pattern detected, return null
- Only mark as recurring if explicitly stated or strongly implied

VALIDATION:
- meeting_date: Must be valid YYYY-MM-DD or null
- meeting_time: Must be standardized format or null
- meeting_type: Must be one of the valid types or null
- confidence: Must be between 0.0 and 1.0
- recurrence: Must be a string pattern or null
- When information cannot be located, return null instead of fabricating values

Return ONLY valid JSON with these exact keys. No markdown, no explanation, no additional text.`;
    
    // Prepare message content array for Claude API
    const content = [];
    
    // Fetch and include all images if available
    let imagesFetched = 0;
    const imageUrls = post.imageUrls || (post.imageUrl ? [post.imageUrl] : []); // Support both old and new format
    
    if (imageUrls.length > 0 && page) {
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
    
    // Make API call to Claude with retry logic
    const message = await retryWithBackoff(async () => {
      return await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
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
    const extractedData = JSON.parse(jsonText);
    
    // Ensure all required keys are present with null as default
    // Use account name as primary source for club_name (more reliable than OCR)
    const structuredData = {
      club_name: post.accountName || extractedData.club_name || null,
      meeting_date: extractedData.meeting_date || null,
      meeting_time: extractedData.meeting_time || null,
      meeting_type: extractedData.meeting_type || null,
      location: extractedData.location || null,
      description: extractedData.description || null,
      confidence: extractedData.confidence || null,
      recurrence: extractedData.recurrence || null,
      // Add original post URL and post date for reference
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
      meeting_date: null,
      meeting_time: null,
      meeting_type: null,
      location: null,
      description: `Error processing post: ${error.message}`,
      confidence: 0.0,
      recurrence: null,
      post_url: post.postUrl || null,
      posted_date: post.postDate || null,
      account_name: post.accountName || null,
      error: error.message
    };
  }
}
