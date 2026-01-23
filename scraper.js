// Instagram scraper module using Playwright
import { retryWithBackoff } from './utils/retry.js';

const parsePositiveInt = (value, fallback) => {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
};

/**
 * Parses Instagram date strings into JavaScript Date objects
 * Handles multiple formats:
 * - ISO datetime: "2024-11-15T10:30:00.000Z"
 * - Relative formats: "2h", "3d", "5w", "1m" (hours, days, weeks, months ago)
 * - Partial dates: "Nov 16" (assumes current year)
 * - Full dates: "January 15, 2024"
 * @param {string} dateString - Date string from Instagram
 * @returns {Date|null} - Parsed Date object or null if parsing fails
 */
export function parseInstagramDate(dateString) {
  if (!dateString || typeof dateString !== 'string') {
    return null;
  }

  try {
    const trimmed = dateString.trim();

    // 1. Try parsing ISO datetime (most reliable - from <time datetime> attribute)
    // Format: "2024-11-15T10:30:00.000Z" or "2024-11-15"
    if (trimmed.includes('T') || /^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
      const isoDate = new Date(trimmed);
      if (!isNaN(isoDate.getTime())) {
        return isoDate;
      }
    }

    // 2. Parse relative formats: "2h", "3d", "5w", "1m"
    // Instagram shows: "2h" = 2 hours ago, "3d" = 3 days ago, etc.
    const relativeMatch = trimmed.match(/^(\d+)\s*(h|d|w|m)$/i);
    if (relativeMatch) {
      const now = new Date();
      const value = parseInt(relativeMatch[1], 10);
      const unit = relativeMatch[2].toLowerCase();

      switch (unit) {
        case 'h': // hours
          return new Date(now.getTime() - value * 60 * 60 * 1000);
        case 'd': // days
          return new Date(now.getTime() - value * 24 * 60 * 60 * 1000);
        case 'w': // weeks
          return new Date(now.getTime() - value * 7 * 24 * 60 * 60 * 1000);
        case 'm': // months (approximate as 30 days)
          return new Date(now.getTime() - value * 30 * 24 * 60 * 60 * 1000);
        default:
          return null;
      }
    }

    // 3. Parse partial dates: "Nov 16", "November 16" (assumes current year)
    const monthNames = [
      'january', 'february', 'march', 'april', 'may', 'june',
      'july', 'august', 'september', 'october', 'november', 'december'
    ];
    const monthAbbrevs = [
      'jan', 'feb', 'mar', 'apr', 'may', 'jun',
      'jul', 'aug', 'sep', 'oct', 'nov', 'dec'
    ];

    const partialDateMatch = trimmed.match(/^([A-Za-z]+)\s+(\d{1,2})$/i);
    if (partialDateMatch) {
      const monthStr = partialDateMatch[1].toLowerCase();
      const day = parseInt(partialDateMatch[2], 10);

      let monthIndex = monthNames.indexOf(monthStr);
      if (monthIndex === -1) {
        monthIndex = monthAbbrevs.indexOf(monthStr);
      }

      if (monthIndex !== -1 && day >= 1 && day <= 31) {
        const now = new Date();
        const year = now.getFullYear();
        const date = new Date(year, monthIndex, day);

        // If the date is in the future (more than 6 months ahead), assume it's from last year
        const sixMonthsFromNow = new Date(now);
        sixMonthsFromNow.setMonth(now.getMonth() + 6);
        if (date > sixMonthsFromNow) {
          date.setFullYear(year - 1);
        }

        return date;
      }
    }

    // 4. Parse full dates: "January 15, 2024", "Jan 15, 2024", "2024-01-15"
    const fullDateMatch = trimmed.match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/i);
    if (fullDateMatch) {
      const monthStr = fullDateMatch[1].toLowerCase();
      const day = parseInt(fullDateMatch[2], 10);
      const year = parseInt(fullDateMatch[3], 10);

      let monthIndex = monthNames.indexOf(monthStr);
      if (monthIndex === -1) {
        monthIndex = monthAbbrevs.indexOf(monthStr);
      }

      if (monthIndex !== -1 && day >= 1 && day <= 31 && year >= 2000 && year <= 2100) {
        return new Date(year, monthIndex, day);
      }
    }

    // 5. Try standard Date.parse as fallback
    const parsed = new Date(trimmed);
    if (!isNaN(parsed.getTime())) {
      return parsed;
    }

    return null;
  } catch (error) {
    // Return null on any parsing error
    return null;
  }
}

/**
 * Detects if Instagram is blocking or challenging the scraper
 * @param {Page} page - Playwright page object
 * @returns {Promise<Object>} - Object with blocked (boolean), reason (string), canRetry (boolean)
 */
async function detectInstagramBlocking(page) {
  try {
    const currentUrl = page.url();
    const pageContent = await page.content();
    const pageText = await page.textContent('body').catch(() => '');
    
    // Check for challenge/verification pages
    // Only check URL for challenge pages (more reliable than text content)
    if (currentUrl.toLowerCase().includes('/challenge/') || 
        currentUrl.toLowerCase().includes('/accounts/challenge/')) {
      return {
        blocked: true,
        reason: 'Instagram challenge detected - may need manual verification',
        canRetry: false
      };
    }
    
    // Check for specific challenge text patterns (more specific)
    const challengePatterns = [
      /suspicious activity/i,
      /confirm it's you/i,
      /help us confirm/i,
      /security check/i,
      /we detected unusual activity/i
    ];
    
    const hasChallenge = challengePatterns.some(pattern => pattern.test(pageText));
    
    if (hasChallenge) {
      return {
        blocked: true,
        reason: 'Instagram challenge detected - may need manual verification',
        canRetry: false
      };
    }
    
    // Check for rate limit messages
    const rateLimitIndicators = [
      'try again later',
      'too many requests',
      'rate limit',
      'please wait',
      'slow down'
    ];
    
    const hasRateLimit = rateLimitIndicators.some(indicator => 
      pageText.toLowerCase().includes(indicator)
    );
    
    if (hasRateLimit) {
      return {
        blocked: true,
        reason: 'Rate limit reached - wait before retrying',
        canRetry: true
      };
    }
    
    // Check if redirected to login when should be logged in
    // If we're on the login page after already being logged in, session may have expired
    if (currentUrl.includes('/accounts/login/')) {
      // This might indicate session expired or account logged out
      return {
        blocked: true,
        reason: 'Session expired or account logged out',
        canRetry: true
      };
    }
    
    // Check for account suspension messages (more specific patterns)
    const suspensionPatterns = [
      /your account has been suspended/i,
      /account suspended/i,
      /this account is disabled/i,
      /account disabled/i,
      /violation of our terms/i
    ];
    
    const hasSuspension = suspensionPatterns.some(pattern => pattern.test(pageText));
    
    if (hasSuspension) {
      return {
        blocked: true,
        reason: 'Account may be temporarily restricted',
        canRetry: false
      };
    }
    
    // Check for 2FA prompts
    const twoFactorIndicators = [
      'two-factor',
      'verification code',
      'enter code',
      'authenticator'
    ];
    
    const hasTwoFactor = twoFactorIndicators.some(indicator => 
      pageText.toLowerCase().includes(indicator)
    );
    
    if (hasTwoFactor && currentUrl.includes('/accounts/login/')) {
      return {
        blocked: true,
        reason: 'Two-factor authentication required',
        canRetry: false
      };
    }
    
    // No blocking detected
    return {
      blocked: false,
      reason: null,
      canRetry: true
    };
  } catch (error) {
    // If detection fails, assume not blocked (allow processing to continue)
    console.warn('Error detecting Instagram blocking:', error.message);
    return {
      blocked: false,
      reason: null,
      canRetry: true
    };
  }
}

/**
 * Logs into Instagram using provided credentials
 * @param {Page} page - Playwright page object
 * @param {string} username - Instagram username
 * @param {string} password - Instagram password
 * @returns {Promise<boolean>} - Returns true if login successful
 * @throws {Error} - Throws error if login fails
 */
export async function loginToInstagram(page, username, password) {
  try {
    console.log('Navigating to Instagram login page...');
    
    // Navigate to Instagram login page with retry logic
    // Use 'domcontentloaded' instead of 'networkidle' as Instagram has continuous network activity
    await retryWithBackoff(async () => {
      return await page.goto('https://www.instagram.com/accounts/login/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });
    }, {
      maxRetries: 2, // Fewer retries for login navigation
      initialDelay: 2000
    });
    
    // Wait for username input field to be visible
    // Instagram may use different selectors - try multiple options
    let usernameSelector = null;
    const usernameSelectors = [
      'input[name="username"]',
      'input[aria-label*="username" i]',
      'input[aria-label*="phone" i]',
      'input[type="text"]',
      'input[autocomplete="username"]'
    ];
    
    for (const selector of usernameSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 3000 });
        usernameSelector = selector;
        console.log(`Found username field using selector: ${selector}`);
        break;
      } catch (e) {
        // Try next selector
      }
    }
    
    if (!usernameSelector) {
      // Take a screenshot for debugging
      await page.screenshot({ path: 'instagram-login-debug.png', fullPage: true });
      throw new Error('Could not find username input field. Screenshot saved as instagram-login-debug.png');
    }
    
    console.log('Filling in login credentials...');
    
    // Fill username field
    await page.fill(usernameSelector, username);
    
    // Fill password field - try multiple selectors
    let passwordSelector = null;
    const passwordSelectors = [
      'input[name="password"]',
      'input[aria-label*="password" i]',
      'input[type="password"]',
      'input[autocomplete="current-password"]'
    ];
    
    for (const selector of passwordSelectors) {
      try {
        if (await page.locator(selector).count() > 0) {
          passwordSelector = selector;
          break;
        }
      } catch (e) {
        // Try next selector
      }
    }
    
    if (!passwordSelector) {
      throw new Error('Could not find password input field');
    }
    
    await page.fill(passwordSelector, password);
    
    // Click login button - try multiple selectors
    const loginButtonSelectors = [
      'button[type="submit"]',
      'button:has-text("Log in")',
      'button:has-text("Log In")',
      'button._acan._acap._acas._aj1-',
      'form button',
      'button[class*="submit"]'
    ];
    
    let loginButtonClicked = false;
    for (const selector of loginButtonSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 3000 });
        await page.click(selector);
        loginButtonClicked = true;
        break;
      } catch (e) {
        // Try next selector
      }
    }
    
    if (!loginButtonClicked) {
      // Try pressing Enter as fallback
      await page.press(passwordSelector, 'Enter');
    }
    
    console.log('Waiting for login to complete...');
    
    // Wait for navigation after login
    // If login is successful, we'll be redirected away from the login page
    // Use a longer timeout and wait for URL change or wait a bit then check
    try {
      await page.waitForURL(/^(?!.*\/accounts\/login\/).*$/, { timeout: 20000 });
    } catch (e) {
      // If URL didn't change, wait a bit and check manually
      await page.waitForTimeout(3000);
    }
    
    // Wait a bit for page to settle (Instagram has continuous network activity)
    await page.waitForTimeout(2000);
    
    // Check if we're still on login page (indicates login failure)
    const currentUrl = page.url();
    if (currentUrl.includes('/accounts/login/')) {
      // Check for blocking/challenge before throwing error
      const blockingStatus = await detectInstagramBlocking(page);
      if (blockingStatus.blocked && !blockingStatus.canRetry) {
        // Only throw if it's a non-retryable block (like 2FA requirement)
        throw new Error(`Login failed: ${blockingStatus.reason}`);
      }
      throw new Error('Login failed - still on login page. Check credentials or if Instagram requires verification.');
    }
    
    // Add configurable delay after successful login (let page settle)
    const delayAfterLogin = parseInt(process.env.DELAY_AFTER_LOGIN_MS || '3000', 10);
    console.log(`Login successful! Waiting ${delayAfterLogin / 1000} seconds...`);
    await page.waitForTimeout(delayAfterLogin);
    
    // Check for blocking after page has settled (but only warn, don't throw)
    const blockingStatus = await detectInstagramBlocking(page);
    if (blockingStatus.blocked) {
      console.warn(`⚠️  Warning: ${blockingStatus.reason}`);
      // Don't throw - allow processing to continue, blocking will be checked during scraping
    }
    
    return true;
  } catch (error) {
    console.error('Error during Instagram login:', error.message);
    throw new Error(`Failed to login to Instagram: ${error.message}`);
  }
}

/**
 * Checks if a post appears to be an intro/pinned post based on its caption
 * Uses word boundary matching to avoid false positives and checks for meeting indicators
 * @param {Object} postData - Post object with caption
 * @returns {boolean} - True if post appears to be intro/pinned
 */
function isIntroPost(postData) {
  if (!postData || !postData.caption) {
    return false;
  }
  
  const caption = postData.caption.toLowerCase();
  
  // FIRST: Check for meeting indicators - if present, likely NOT an intro post
  // This prevents false positives for legitimate meeting announcements
  const hasMonth = /\b(november|december|january|february|march|april|may|june|july|august|september|october)\b/i.test(caption);
  const hasTime = /\d{1,2}[:\/]\d{2}/.test(caption);
  const hasLocation = /\b(room|rm|b\d+|c\d+|e\d+|p\d+|m\d+|horseshoe|btq|cafeteria|library|gym|auditorium|a1|a2|a3|a4|a5)\b/i.test(caption);
  const hasDatePattern = /\b(nov|dec|jan|feb|mar|apr|may|jun|jul|aug|sep|oct)\s+\d{1,2}\b/i.test(caption);
  const hasMeetingKeywords = /\b(meeting|event|gathering|session|workshop|fundraiser|volunteer|competition)\b/i.test(caption);
  
  // If post has clear meeting indicators, it's NOT an intro post
  if (hasMonth || hasTime || hasLocation || hasDatePattern || hasMeetingKeywords) {
    return false;
  }
  
  // Keywords commonly found in intro/pinned posts
  // Use word boundaries to prevent false positives (e.g., "invites" matching "intro")
  const introKeywords = [
    '\\bwelcome\\b',
    '\\bintro\\b',  // Word boundary prevents "invites" from matching
    '\\bintroduction\\b',
    'about us',
    'about our',
    'who we are',
    'what we do',
    'our mission',
    '\\bjoin us\\b',  // Word boundary prevents "joining" from matching
    '\\bpinned\\b',
    'important announcement',
    'announcement:',
    'read this first',
    'hey everyone',
    'hi everyone',
    'welcome to',
    'new members',
    'for new members',
    'start here',
    'first time'
  ];
  
  // Check if caption contains intro keywords using word boundary matching
  const hasIntroKeyword = introKeywords.some(keyword => {
    // For multi-word phrases, use simple includes (they're already specific)
    if (keyword.includes(' ')) {
      return caption.includes(keyword);
    }
    // For single words, use word boundary regex to prevent substring matches
    const regex = new RegExp(keyword, 'i');
    return regex.test(caption);
  });
  
  // Very short captions (likely just emojis or minimal text) might be intro posts
  const isVeryShort = postData.caption.length < 30;
  
  // Very long captions (likely informational/about posts)
  const isVeryLong = postData.caption.length > 500;
  
  // Return true only if it has intro keywords AND doesn't have meeting indicators
  // OR if it's very short without time/date patterns
  // OR if it's very long with intro keywords
  return hasIntroKeyword || (isVeryShort && !caption.match(/\d{1,2}[:\/]\d{2}/)) || (isVeryLong && hasIntroKeyword);
}

/**
 * Extracts post URLs from a club's Instagram profile page (fast method)
 * Extracts more posts than needed to allow filtering of intro/pinned posts
 * @param {Page} page - Playwright page object
 * @param {string} clubUsername - Instagram username of the club
 * @param {number} maxPosts - Maximum number of post URLs to extract (will extract more to filter)
 * @returns {Promise<Array<string>>} - Array of post URLs
 */
async function extractPostUrlsFromProfile(page, clubUsername, maxPosts) {
  try {
    // Extract more posts than needed to have enough after filtering intro posts
    // Typically extract 1-2 extra posts to account for intro posts
    const extractCount = maxPosts + 2;
    
    const postUrls = await page.evaluate((extractCount) => {
      const urls = [];
      const seenUrls = new Set();
      
      // Find all post links (href contains /p/)
      const postLinks = document.querySelectorAll('a[href*="/p/"]');
      
      for (const link of postLinks) {
        if (urls.length >= extractCount) break;
        
        // Check if this post is pinned by looking for the pinned post icon SVG
        // The pinned icon is typically in the same container or nearby
        let isPinned = false;
        
        // Check the link's parent containers for the pinned icon SVG
        let parent = link.parentElement;
        let depth = 0;
        const maxDepth = 5; // Limit search depth to avoid going too far up
        
        while (parent && depth < maxDepth) {
          // Look for SVG with aria-label containing "Pinned post icon"
          const pinnedIcon = parent.querySelector('svg[aria-label*="Pinned post icon" i]');
          if (pinnedIcon) {
            isPinned = true;
            break;
          }
          parent = parent.parentElement;
          depth++;
        }
        
        // If not found in parents, check siblings and nearby elements
        if (!isPinned) {
          // Check previous siblings
          let sibling = link.previousElementSibling;
          let siblingDepth = 0;
          while (sibling && siblingDepth < 3) {
            const pinnedIcon = sibling.querySelector('svg[aria-label*="Pinned post icon" i]');
            if (pinnedIcon) {
              isPinned = true;
              break;
            }
            sibling = sibling.previousElementSibling;
            siblingDepth++;
          }
        }
        
        // Skip pinned posts
        if (isPinned) {
          continue;
        }
        
        const href = link.href;
        // Ensure it's a full URL
        const fullUrl = href.startsWith('http') ? href : `https://www.instagram.com${href}`;
        
        // Skip duplicates
        if (!seenUrls.has(fullUrl)) {
          seenUrls.add(fullUrl);
          urls.push(fullUrl);
        }
      }
      
      return urls;
    }, extractCount);
    
    return postUrls;
  } catch (error) {
    console.error('Error extracting post URLs from profile:', error.message);
    return [];
  }
}

/**
 * Extracts only the post date from an Instagram post page (lightweight, for date filtering)
 * This is faster than full extraction and used to filter posts before expensive operations
 * @param {Page} page - Playwright page object
 * @param {string} postUrl - URL of the Instagram post
 * @param {string} accountName - Name of the Instagram account
 * @returns {Promise<Object|null>} - Object with postUrl, postDate, postDateObj, postDateRaw, or null if extraction fails
 */
async function extractPostDateOnly(page, postUrl, accountName) {
  try {
    // Navigate to post page with retry logic
    await retryWithBackoff(async () => {
      return await page.goto(postUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });
    }, {
      maxRetries: 2,
      initialDelay: 1000
    });
    
    // Wait for post content to load (shorter delay for date-only extraction)
    const dateExtractionDelay = parseInt(process.env.DATE_EXTRACTION_DELAY_MS || '1000', 10);
    await page.waitForTimeout(dateExtractionDelay);
    
    // Extract only the date from the page (no images, no caption)
    const dateData = await page.evaluate(() => {
      const data = {
        postUrl: window.location.href,
        postDate: null,
        postDateRaw: null
      };
      
      // Extract post date - Instagram uses <time> element with datetime attribute
      // The time element is typically nested: article > a > span > time[datetime]
      // May also have text content like "2h", "3d", "Nov 16"
      const timeSelectors = [
        'article time[datetime]',           // Most specific: time within article
        'article a time[datetime]',         // Time within link in article
        'article span time[datetime]',      // Time within span in article
        'time[datetime]',                   // Any time with datetime attribute
        'time'                               // Fallback: any time element
      ];
      
      let dateString = null;
      
      // Extract post date using selectors
      for (const selector of timeSelectors) {
        const timeElement = document.querySelector(selector);
        
        if (timeElement) {
          // Try datetime attribute first (most reliable - ISO format)
          const datetime = timeElement.getAttribute('datetime');
          if (datetime) {
            dateString = datetime;
            break;
          }
          // Try text content (might be "2h", "3d", "Nov 16", etc.)
          const timeText = timeElement.textContent?.trim();
          if (timeText && timeText.length > 0) {
            dateString = timeText;
            break;
          }
        }
      }
      
      // If still no date, try to get from meta tags
      if (!dateString) {
        const metaPublishedTime = document.querySelector('meta[property="article:published_time"]');
        if (metaPublishedTime) {
          const datetime = metaPublishedTime.getAttribute('content');
          if (datetime) {
            dateString = datetime;
          }
        }
      }
      
      data.postDateRaw = dateString;
      return data;
    });
    
    // Ensure we have at least a post URL
    if (!dateData || !dateData.postUrl) {
      return null;
    }
    
    // Parse the date using parseInstagramDate if we have a raw date string
    if (dateData.postDateRaw) {
      try {
        const parsedDate = parseInstagramDate(dateData.postDateRaw);
        if (parsedDate) {
          // Format as YYYY-MM-DD for consistency
          const year = parsedDate.getFullYear();
          const month = String(parsedDate.getMonth() + 1).padStart(2, '0');
          const day = String(parsedDate.getDate()).padStart(2, '0');
          dateData.postDate = `${year}-${month}-${day}`;
          dateData.postDateObj = parsedDate; // Store Date object for comparison
        } else {
          dateData.postDate = null;
          dateData.postDateObj = null;
        }
      } catch (error) {
        dateData.postDate = null;
        dateData.postDateObj = null;
      }
    } else {
      dateData.postDate = null;
      dateData.postDateObj = null;
    }
    
    return dateData;
  } catch (error) {
    console.error(`Error extracting date from post ${postUrl}:`, error.message);
    return null;
  }
}

/**
 * Extracts full post data from an individual post page
 * @param {Page} page - Playwright page object
 * @param {string} postUrl - URL of the Instagram post
 * @param {string} accountName - Name of the Instagram account
 * @returns {Promise<Object|null>} - Post object with postUrl, imageUrls (array), caption, accountName, postDate
 */
async function extractPostFromPage(page, postUrl, accountName) {
  try {
    // Navigate to post page with retry logic
    await retryWithBackoff(async () => {
      return await page.goto(postUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });
    }, {
      maxRetries: 2,
      initialDelay: 1000
    });
    
    // Wait for post content to load (configurable delay)
    const delayPostLoad = parseInt(process.env.DELAY_POST_LOAD_MS || '2000', 10);
    await page.waitForTimeout(delayPostLoad);
    
    // Extract post data from the page
    const postData = await page.evaluate((account) => {
      const data = {
        postUrl: window.location.href,
        imageUrls: [],
        caption: null,
        accountName: account,
        postDate: null
      };
      
      // Extract all image URLs from carousel or single image post
      // Instagram carousels contain multiple images in the article
      const imgSelectors = [
        'article img[src*="instagram.com"]',
        'article img[srcset*="instagram.com"]',
        'img[src*="scontent"]',
        'article img'
      ];
      
      const seenUrls = new Set();
      
      // Try each selector to find all images
      for (const selector of imgSelectors) {
        const imgs = document.querySelectorAll(selector);
        
        for (const img of imgs) {
          let imageUrl = null;
          
          // Try src first
          imageUrl = img.src || img.getAttribute('src');
          
          // If not found or low quality, try srcset
          if (!imageUrl || imageUrl.includes('640x640')) {
            const srcset = img.getAttribute('srcset');
            if (srcset) {
              // Get the highest resolution image from srcset
              const urls = srcset.split(',').map(s => s.trim().split(' ')[0]);
              // Prefer larger images (avoid thumbnails)
              imageUrl = urls[urls.length - 1] || urls[0];
            }
          }
          
          // Add to array if valid and not duplicate
          if (imageUrl && imageUrl.startsWith('http') && !seenUrls.has(imageUrl)) {
            // Filter out very small images (likely thumbnails/icons)
            if (!imageUrl.includes('150x150') && !imageUrl.includes('50x50')) {
              seenUrls.add(imageUrl);
              data.imageUrls.push(imageUrl);
            }
          }
        }
        
        // If we found images with this selector, break (don't need to try others)
        if (data.imageUrls.length > 0) {
          break;
        }
      }
      
      // If no images found, try alternative approach for carousel posts
      // Look for carousel container and extract images from there
      if (data.imageUrls.length === 0) {
        // Try finding images in carousel slides
        const carouselSlides = document.querySelectorAll('article div[role="button"] img, article ul li img');
        for (const img of carouselSlides) {
          const src = img.src || img.getAttribute('src');
          const srcset = img.getAttribute('srcset');
          
          let imageUrl = src;
          if (srcset) {
            const urls = srcset.split(',').map(s => s.trim().split(' ')[0]);
            imageUrl = urls[urls.length - 1] || urls[0] || src;
          }
          
          if (imageUrl && imageUrl.startsWith('http') && !seenUrls.has(imageUrl)) {
            if (!imageUrl.includes('150x150') && !imageUrl.includes('50x50')) {
              seenUrls.add(imageUrl);
              data.imageUrls.push(imageUrl);
            }
          }
        }
      }
      
      // Extract post date - Instagram uses <time> element with datetime attribute
      // The time element is typically nested: article > a > span > time[datetime]
      // May also have text content like "2h", "3d", "Nov 16"
      const timeSelectors = [
        'article time[datetime]',           // Most specific: time within article
        'article a time[datetime]',         // Time within link in article
        'article span time[datetime]',      // Time within span in article
        'time[datetime]',                   // Any time with datetime attribute
        'time'                               // Fallback: any time element
      ];
      
      let dateString = null;
      const dateDebugInfo = { selectorsTried: [], found: false, method: null, selectorUsed: null };
      
      // Extract post date using selectors
      for (const selector of timeSelectors) {
        const timeElement = document.querySelector(selector);
        dateDebugInfo.selectorsTried.push({ selector, found: !!timeElement });
        
        if (timeElement) {
          // Try datetime attribute first (most reliable - ISO format)
          const datetime = timeElement.getAttribute('datetime');
          if (datetime) {
            dateString = datetime;
            dateDebugInfo.found = true;
            dateDebugInfo.method = 'datetime-attribute';
            dateDebugInfo.selectorUsed = selector;
            break;
          }
          // Try text content (might be "2h", "3d", "Nov 16", etc.)
          const timeText = timeElement.textContent?.trim();
          if (timeText && timeText.length > 0) {
            dateString = timeText;
            dateDebugInfo.found = true;
            dateDebugInfo.method = 'text-content';
            dateDebugInfo.selectorUsed = selector;
            break;
          }
        }
      }
      
      // If still no date, try to get from meta tags
      if (!dateString) {
        const metaPublishedTime = document.querySelector('meta[property="article:published_time"]');
        if (metaPublishedTime) {
          const datetime = metaPublishedTime.getAttribute('content');
          if (datetime) {
            dateString = datetime;
            dateDebugInfo.found = true;
            dateDebugInfo.method = 'meta-tag';
            dateDebugInfo.selectorUsed = 'meta[property="article:published_time"]';
          }
        }
      }
      
      // Store raw date string for parsing outside evaluate context
      data.postDateRaw = dateString;
      data.dateDebugInfo = dateDebugInfo;
      
      // Extract caption - try multiple selectors
      const captionSelectors = [
        'article span',
        'h1 + span',
        'div[role="button"] span',
        'article div[dir="auto"] span'
      ];
      
      for (const selector of captionSelectors) {
        const elements = document.querySelectorAll(selector);
        for (const element of elements) {
          const text = element.textContent?.trim();
          if (text && text.length > 20) { // Only take substantial captions
            data.caption = text;
            break;
          }
        }
        if (data.caption) break;
      }
      
      // If still no caption, try to get from meta tags
      if (!data.caption) {
        const metaDescription = document.querySelector('meta[property="og:description"]');
        if (metaDescription) {
          data.caption = metaDescription.getAttribute('content');
        }
      }
      
      return data;
    }, accountName);
    
    // Ensure we have at least a post URL
    if (!postData || !postData.postUrl) {
      return null;
    }
    
    // Log date extraction debug info
    if (postData.dateDebugInfo) {
      if (postData.dateDebugInfo.found) {
        console.log(`  [DOM DEBUG] Date found via ${postData.dateDebugInfo.method} using selector '${postData.dateDebugInfo.selectorUsed}': ${postData.postDateRaw}`);
      } else {
        console.log(`  [DOM DEBUG] No date found. Selectors tried: ${postData.dateDebugInfo.selectorsTried.map(s => `${s.selector}(${s.found ? 'found' : 'not found'})`).join(', ')}`);
      }
      delete postData.dateDebugInfo; // Clean up
    }
    
    // Parse the date using parseInstagramDate if we have a raw date string
    if (postData.postDateRaw) {
      try {
        const parsedDate = parseInstagramDate(postData.postDateRaw);
        if (parsedDate) {
          // Format as YYYY-MM-DD for consistency
          const year = parsedDate.getFullYear();
          const month = String(parsedDate.getMonth() + 1).padStart(2, '0');
          const day = String(parsedDate.getDate()).padStart(2, '0');
          postData.postDate = `${year}-${month}-${day}`;
          postData.postDateObj = parsedDate; // Store Date object for comparison
        } else {
          console.warn(`Warning: Could not parse date "${postData.postDateRaw}" for post ${postUrl}`);
          postData.postDate = null;
        }
      } catch (error) {
        console.warn(`Warning: Error parsing date "${postData.postDateRaw}" for post ${postUrl}: ${error.message}`);
        postData.postDate = null;
      }
      // Remove postDateRaw as we've parsed it
      delete postData.postDateRaw;
    } else {
      postData.postDate = null;
    }
    
    return postData;
  } catch (error) {
    console.error(`Error extracting post from page ${postUrl}:`, error.message);
    return null;
  }
}

/**
 * Generates a random delay between min and max milliseconds
 * @param {number} min - Minimum delay in milliseconds
 * @param {number} max - Maximum delay in milliseconds
 * @returns {number} - Random delay value
 */
function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Scrapes posts from a specific club's Instagram account with date range filtering and early termination
 * Implements smart scrolling with date-based filtering:
 * - Scrolls through posts chronologically (newest first)
 * - Uses batch checking for early termination: only stops after finding MAX_CONSECUTIVE_OLD_POSTS 
 *   consecutive posts older than startDate (prevents premature stopping when posts are out of order)
 * - Filters posts by date range and URL deduplication
 * - Enforces limits: max 10 posts, max 10 scrolls
 * 
 * Early Termination Strategy:
 * - Counts consecutive posts older than START_DATE across all scrolls
 * - Only stops after finding MAX_CONSECUTIVE_OLD_POSTS (default: 3) consecutive old posts
 * - Resets counter when finding a post at or after START_DATE
 * - This handles cases where posts may appear out of chronological order in the DOM
 * 
 * @param {Page} page - Playwright page object
 * @param {string} clubUsername - Instagram username of the club
 * @param {Date} startDate - Only scrape posts on or after this date (UTC)
 * @param {Date} endDate - Only scrape posts on or before this date (UTC)
 * @param {Set<string>} existingUrls - Set of existing post URLs to skip
 * @returns {Promise<Object>} - Object with newPosts, stoppedAt, totalScraped, duplicatesSkipped
 */
export async function scrapeClubPosts(page, clubUsername, startDate, endDate, existingUrls = new Set()) {
  const MAX_POSTS = parsePositiveInt(process.env.MAX_POSTS_PER_CLUB, 10);
  const MAX_SCROLLS = parsePositiveInt(process.env.MAX_SCROLLS_PER_CLUB, 10);
  const MAX_CONSECUTIVE_OLD_POSTS = parsePositiveInt(process.env.MAX_CONSECUTIVE_OLD_POSTS, 3); // Number of consecutive old posts before stopping early
  const ENABLE_DATE_FIRST_FILTERING = process.env.ENABLE_DATE_FIRST_FILTERING !== 'false'; // Default: true
  const newPosts = [];
  let totalScraped = 0;
  let duplicatesSkipped = 0;
  let dateChecksSkipped = 0; // Track posts skipped by date before full extraction
  let stoppedAt = null;
  let earlyTerminated = false;
  let consecutiveOldPosts = 0; // Track consecutive posts older than START_DATE

  try {
    console.log(`Scraping posts from @${clubUsername}...`);
    console.log(`  Date range: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);
    
    // Check for blocking before starting
    const initialBlockingStatus = await detectInstagramBlocking(page);
    if (initialBlockingStatus.blocked) {
      console.warn(`⚠️  Instagram blocking detected for @${clubUsername}: ${initialBlockingStatus.reason}`);
      if (!initialBlockingStatus.canRetry) {
        // Handle rate limiting - pause 30 seconds and retry once
        if (initialBlockingStatus.reason.includes('rate limit')) {
          console.log('  Pausing 30 seconds due to rate limit...');
          await page.waitForTimeout(30000);
          // Retry once
          const retryStatus = await detectInstagramBlocking(page);
          if (retryStatus.blocked) {
            return { newPosts: [], stoppedAt: null, totalScraped: 0, duplicatesSkipped: 0, dateChecksSkipped: 0 };
          }
        } else {
          return { newPosts: [], stoppedAt: null, totalScraped: 0, duplicatesSkipped: 0, dateChecksSkipped: 0 };
        }
      }
    }
    
    // Step 1: Navigate to club's Instagram profile with retry logic
    const profileUrl = `https://www.instagram.com/${clubUsername}/`;
    await retryWithBackoff(async () => {
      return await page.goto(profileUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });
    }, {
      maxRetries: 2,
      initialDelay: 1000
    });
    
    // Check for blocking after navigation
    const blockingStatus = await detectInstagramBlocking(page);
    if (blockingStatus.blocked) {
      console.warn(`⚠️  Instagram blocking detected after navigating to @${clubUsername}: ${blockingStatus.reason}`);
      if (!blockingStatus.canRetry) {
        if (blockingStatus.reason.includes('rate limit')) {
          console.log('  Pausing 30 seconds due to rate limit...');
          await page.waitForTimeout(30000);
          const retryStatus = await detectInstagramBlocking(page);
          if (retryStatus.blocked) {
            return { newPosts: [], stoppedAt: null, totalScraped: 0, duplicatesSkipped: 0, dateChecksSkipped: 0 };
          }
        } else {
          return { newPosts: [], stoppedAt: null, totalScraped: 0, duplicatesSkipped: 0, dateChecksSkipped: 0 };
        }
      }
    }
    
    // Wait for the page to fully load
    const delayProfileLoad = parseInt(process.env.DELAY_PROFILE_LOAD_MS || '3000', 10);
    await page.waitForTimeout(delayProfileLoad);
    
    // Wait for posts to be visible
    let postsFound = false;
    const selectors = ['a[href*="/p/"]', 'article', 'main article', 'div[role="main"] article'];
    let workingSelector = null;
    
    console.log(`  [DOM DEBUG] Checking for posts with selectors: ${selectors.join(', ')}`);
    for (const selector of selectors) {
      try {
        await page.waitForSelector(selector, { timeout: 5000 });
        const count = await page.evaluate((sel) => document.querySelectorAll(sel).length, selector);
        console.log(`  [DOM DEBUG] Selector '${selector}' found ${count} element(s)`);
        if (count > 0) {
          postsFound = true;
          workingSelector = selector;
          break;
        }
      } catch (e) {
        console.log(`  [DOM DEBUG] Selector '${selector}' not found or timed out`);
        // Try next selector
      }
    }
    
    if (!postsFound) {
      console.warn(`Could not find posts for @${clubUsername} - posts may not be loaded or account may be private`);
      return { newPosts: [], stoppedAt: null, totalScraped: 0, duplicatesSkipped: 0 };
    }
    
    console.log(`  [DOM DEBUG] Using selector '${workingSelector}' for post detection`);

    // Track seen URLs to avoid duplicates during scrolling
    const seenUrls = new Set();
    let scrollCount = 0;

    // Scroll loop: extract post URLs incrementally and process them
    while (scrollCount < MAX_SCROLLS && newPosts.length < MAX_POSTS && !earlyTerminated) {
      // Extract post URLs from current viewport
      const result = await page.evaluate(() => {
        const urls = [];
        const seen = new Set();
        const debugInfo = {
          totalLinksFound: 0,
          pinnedPostsFound: 0,
          uniqueUrls: 0,
          pinnedDetectionMethods: []
        };
        
        // Find all post links (href contains /p/)
        const postLinks = document.querySelectorAll('a[href*="/p/"]');
        debugInfo.totalLinksFound = postLinks.length;
        
        for (const link of postLinks) {
          // Check if this post is pinned - ONLY check within the link element itself
          // This is the most reliable method and avoids false positives from other posts
          const pinnedIconInLink = link.querySelector('svg[aria-label*="Pinned post icon" i]');
          
          // Skip pinned posts
          if (pinnedIconInLink) {
            debugInfo.pinnedPostsFound++;
            debugInfo.pinnedDetectionMethods.push({ method: 'found-in-link-element', href: link.href });
            continue;
          }
          
          const href = link.href;
          const fullUrl = href.startsWith('http') ? href : `https://www.instagram.com${href}`;
          
          if (!seen.has(fullUrl)) {
            seen.add(fullUrl);
            urls.push(fullUrl);
            debugInfo.uniqueUrls++;
          }
        }
        
        return { urls, debugInfo };
      });
      
      const extractedUrls = result.urls;
      const debugInfo = result.debugInfo;
      
      console.log(`  [DOM DEBUG] Scroll ${scrollCount + 1}: Found ${debugInfo.totalLinksFound} links with selector 'a[href*="/p/"]'`);
      console.log(`  [DOM DEBUG]   - Pinned posts: ${debugInfo.pinnedPostsFound}`);
      console.log(`  [DOM DEBUG]   - Unique URLs to process: ${debugInfo.uniqueUrls}`);
      if (debugInfo.pinnedPostsFound > 0) {
        debugInfo.pinnedDetectionMethods.forEach((pin, idx) => {
          console.log(`  [DOM DEBUG]   - Pinned post ${idx + 1}: ${pin.method} (${pin.href})`);
        });
      }

      // Process each post URL
      for (const postUrl of extractedUrls) {
        // Skip if we've already seen this URL in this run
        if (seenUrls.has(postUrl)) {
          continue;
        }
        seenUrls.add(postUrl);

        // Skip if we've hit the post limit
        if (newPosts.length >= MAX_POSTS) {
          break;
        }

        // Check if URL already exists in spreadsheet
        if (existingUrls.has(postUrl.trim())) {
          duplicatesSkipped++;
          continue;
        }

        // Two-phase extraction: First check date, then do full extraction if needed
        try {
          let postDateObj = null;
          let postDateOnly = null;
          let dateCheckPassed = false;

          // Phase 1: Quick date check (if optimization enabled)
          if (ENABLE_DATE_FIRST_FILTERING) {
            try {
              const dateOnly = await extractPostDateOnly(page, postUrl, clubUsername);
              
              if (dateOnly && dateOnly.postDateObj) {
                postDateObj = dateOnly.postDateObj;
                
                // Normalize dates to midnight (UTC) for comparison
                postDateOnly = new Date(Date.UTC(
                  postDateObj.getUTCFullYear(),
                  postDateObj.getUTCMonth(),
                  postDateObj.getUTCDate()
                ));
                const startDateOnly = new Date(Date.UTC(
                  startDate.getUTCFullYear(),
                  startDate.getUTCMonth(),
                  startDate.getUTCDate()
                ));
                const endDateOnly = new Date(Date.UTC(
                  endDate.getUTCFullYear(),
                  endDate.getUTCMonth(),
                  endDate.getUTCDate()
                ));

                // Check if post is before START_DATE
                if (postDateOnly < startDateOnly) {
                  consecutiveOldPosts++;
                  stoppedAt = dateOnly.postDate;
                  
                  if (consecutiveOldPosts >= MAX_CONSECUTIVE_OLD_POSTS) {
                    earlyTerminated = true;
                    console.log(`  🛑 Stopped at date ${dateOnly.postDate} (found ${MAX_CONSECUTIVE_OLD_POSTS} consecutive posts older than START_DATE)`);
                    dateChecksSkipped++;
                    break;
                  } else {
                    console.log(`  ⏭️  Post ${dateOnly.postDate} is older than START_DATE, skipping full extraction (${consecutiveOldPosts}/${MAX_CONSECUTIVE_OLD_POSTS} consecutive old posts)`);
                    dateChecksSkipped++;
                    continue; // Skip this old post but keep checking
                  }
                }

                // Reset consecutive old posts counter when we find a post at or after START_DATE
                if (consecutiveOldPosts > 0) {
                  consecutiveOldPosts = 0;
                  console.log(`  ✓ Found post within/after date range, resetting old post counter`);
                }

                // Check if post is after END_DATE
                if (postDateOnly > endDateOnly) {
                  console.log(`  ⏭️  Post ${dateOnly.postDate} is after END_DATE, skipping full extraction`);
                  dateChecksSkipped++;
                  continue;
                }

                // Date is in range - proceed to full extraction
                dateCheckPassed = true;
              } else {
                // Date extraction failed - fall back to full extraction for safety
                console.log(`  ⚠️  Could not extract date for ${postUrl}, falling back to full extraction`);
              }
            } catch (dateError) {
              // Date extraction error - fall back to full extraction for safety
              console.warn(`  ⚠️  Error in date extraction for ${postUrl}: ${dateError.message}, falling back to full extraction`);
            }
          }

          // Phase 2: Full extraction (only if date check passed or optimization disabled)
          if (!ENABLE_DATE_FIRST_FILTERING || dateCheckPassed || !postDateObj) {
            // Random delay 1-2 seconds when extracting post data
            const extractDelay = randomDelay(1000, 2000);
            await page.waitForTimeout(extractDelay);

            const postData = await extractPostFromPage(page, postUrl, clubUsername);
            
            if (!postData) {
              console.warn(`  ⚠️  Could not extract data from ${postUrl}`);
              continue;
            }

            totalScraped++;

            // If we already have postDateObj from date-only extraction, we've already checked the date range
            // Otherwise, parse from full extraction and check date range
            if (!postDateObj) {
              if (postData.postDateObj) {
                postDateObj = postData.postDateObj;
              } else if (postData.postDate) {
                const dateMatch = postData.postDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
                if (dateMatch) {
                  const [, year, month, day] = dateMatch;
                  postDateObj = new Date(Date.UTC(parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10)));
                } else {
                  postDateObj = parseInstagramDate(postData.postDate);
                }
              }

              // If we still couldn't parse the date, log warning but continue
              if (!postDateObj || isNaN(postDateObj.getTime())) {
                console.warn(`  ⚠️  Could not parse date for post ${postUrl}, skipping date check`);
                // Without a date, we can't determine if it's in range, so skip it
                continue;
              }

              // Normalize dates to midnight (UTC) for comparison
              postDateOnly = new Date(Date.UTC(
                postDateObj.getUTCFullYear(),
                postDateObj.getUTCMonth(),
                postDateObj.getUTCDate()
              ));
              const startDateOnly = new Date(Date.UTC(
                startDate.getUTCFullYear(),
                startDate.getUTCMonth(),
                startDate.getUTCDate()
              ));
              const endDateOnly = new Date(Date.UTC(
                endDate.getUTCFullYear(),
                endDate.getUTCMonth(),
                endDate.getUTCDate()
              ));

              // Batch checking for early termination: count consecutive old posts
              if (postDateOnly < startDateOnly) {
                consecutiveOldPosts++;
                stoppedAt = postData.postDate;
                
                if (consecutiveOldPosts >= MAX_CONSECUTIVE_OLD_POSTS) {
                  earlyTerminated = true;
                  console.log(`  🛑 Stopped at date ${postData.postDate} (found ${MAX_CONSECUTIVE_OLD_POSTS} consecutive posts older than START_DATE)`);
                  break;
                } else {
                  console.log(`  ⏭️  Post ${postData.postDate} is older than START_DATE (${consecutiveOldPosts}/${MAX_CONSECUTIVE_OLD_POSTS} consecutive old posts)`);
                  continue;
                }
              }

              // Reset consecutive old posts counter when we find a post at or after START_DATE
              if (consecutiveOldPosts > 0) {
                consecutiveOldPosts = 0;
                console.log(`  ✓ Found post within/after date range, resetting old post counter`);
              }

              // Skip if post date > endDate (too recent, outside our range)
              if (postDateOnly > endDateOnly) {
                continue;
              }
            }
            // If postDateObj exists from Phase 1, date range was already checked and passed

            // Post is within date range and URL is not duplicate
            // Filter out intro/pinned posts
            if (isIntroPost(postData)) {
              console.log(`  ⏭️  Skipped intro post: ${postData.caption ? postData.caption.substring(0, 50) + '...' : 'No caption'}`);
              continue;
            }

            // This is a new post to process
            newPosts.push(postData);
            console.log(`  ✓ New post found (${postData.postDate}): ${postData.caption ? postData.caption.substring(0, 50) + '...' : 'No caption'}`);
          }
        } catch (error) {
          console.error(`  ✗ Error processing post ${postUrl}: ${error.message}`);
          // Continue with next post
        }

        // Break out of post loop if we've hit limits or early terminated
        if (newPosts.length >= MAX_POSTS || earlyTerminated) {
          break;
        }
      }

      // Break out of scroll loop if we've hit limits or early terminated
      if (newPosts.length >= MAX_POSTS || earlyTerminated) {
        break;
      }

      // Scroll down to load more posts (human-like scrolling by viewport height)
      scrollCount++;
      if (scrollCount < MAX_SCROLLS && !earlyTerminated) {
        await page.evaluate(() => {
          const viewportHeight = window.innerHeight;
          window.scrollBy(0, viewportHeight);
        });

        // Wait for lazy-loaded content to appear after scrolling
        // Instagram uses lazy loading, so we need to wait for new posts to load
        await page.waitForTimeout(1000);

        // Random delay 2-4 seconds between scrolls (additional wait for rate limiting)
        const scrollDelay = randomDelay(2000, 4000);
        await page.waitForTimeout(scrollDelay);
      }
    }

    // Log summary for this club
    const stopReason = stoppedAt 
      ? `, stopped at date ${stoppedAt} (after ${MAX_CONSECUTIVE_OLD_POSTS} consecutive old posts)`
      : '';
    const dateSkipInfo = dateChecksSkipped > 0 
      ? `, ${dateChecksSkipped} skipped before full extraction (date out of range)`
      : '';
    console.log(`@${clubUsername}: Found ${newPosts.length} new posts in date range, ${duplicatesSkipped} duplicates skipped, ${totalScraped} total scraped${dateSkipInfo}${stopReason}`);

    // Add configurable delay before processing next club
    const delayAfterClub = parseInt(process.env.DELAY_AFTER_CLUB_MS || '2000', 10);
    await page.waitForTimeout(delayAfterClub);

    return {
      newPosts,
      stoppedAt,
      totalScraped,
      duplicatesSkipped,
      dateChecksSkipped
    };

  } catch (error) {
    console.error(`Error scraping posts from @${clubUsername}:`, error.message);
    // Return results so far instead of throwing to allow processing of other clubs
    return {
      newPosts,
      stoppedAt,
      totalScraped,
      duplicatesSkipped,
      dateChecksSkipped: 0
    };
  }
}

// Note: The old extractPostData function has been replaced with the hybrid approach:
// 1. extractPostUrlsFromProfile() - Fast extraction of post URLs from profile
// 2. extractPostFromPage() - Full data extraction from individual post pages
