// Retry utility with exponential backoff for handling transient failures

/**
 * Extracts Retry-After delay from error response headers
 * @param {Error} error - The error object that may contain response headers
 * @returns {number|null} - Delay in milliseconds, or null if not found
 */
export function getRetryAfterDelay(error) {
  // Check for Retry-After header in various locations
  const headers = error.headers || error.response?.headers || {};
  const retryAfter = headers['retry-after'] || headers['Retry-After'];

  if (!retryAfter) {
    return null;
  }

  // Retry-After can be a number of seconds or an HTTP date
  const parsed = parseInt(retryAfter, 10);
  if (!isNaN(parsed)) {
    // It's a number of seconds
    return parsed * 1000;
  }

  // Try parsing as HTTP date
  const date = new Date(retryAfter);
  if (!isNaN(date.getTime())) {
    const now = Date.now();
    const delay = date.getTime() - now;
    return delay > 0 ? delay : null;
  }

  return null;
}

/**
 * Extracts rate limit information from error response
 * @param {Error} error - The error object
 * @returns {Object} - Rate limit info { remaining, limit, reset }
 */
export function getRateLimitInfo(error) {
  const headers = error.headers || error.response?.headers || {};

  return {
    remaining: headers['x-ratelimit-remaining'] || headers['X-RateLimit-Remaining'] || null,
    limit: headers['x-ratelimit-limit'] || headers['X-RateLimit-Limit'] || null,
    reset: headers['x-ratelimit-reset'] || headers['X-RateLimit-Reset'] || null
  };
}

/**
 * Determines if an error should be retried based on error type and status code
 * @param {Error} error - The error to check
 * @returns {boolean} - True if the error should be retried
 */
export function shouldRetry(error) {
  // Network errors (connection failures, timeouts)
  if (error.message && (
    error.message.includes('ECONNRESET') ||
    error.message.includes('ETIMEDOUT') ||
    error.message.includes('ENOTFOUND') ||
    error.message.includes('network') ||
    error.message.includes('timeout')
  )) {
    return true;
  }

  // HTTP status codes
  if (error.status || error.statusCode || error.response?.status) {
    const status = error.status || error.statusCode || error.response?.status;
    
    // Retry on rate limits (429)
    if (status === 429) {
      return true;
    }
    
    // Retry on server errors (500-599)
    if (status >= 500 && status < 600) {
      return true;
    }
    
    // Don't retry on client errors (400-499) except 429
    if (status >= 400 && status < 500) {
      return false;
    }
  }

  // Retry on generic errors (might be transient)
  // But don't retry on authentication errors
  if (error.message && (
    error.message.includes('authentication') ||
    error.message.includes('unauthorized') ||
    error.message.includes('forbidden') ||
    error.message.includes('not found') ||
    error.message.includes('404')
  )) {
    return false;
  }

  // Default: retry on unknown errors (might be transient)
  return true;
}

/**
 * Retries a function with exponential backoff
 * @param {Function} fn - Async function to retry
 * @param {Object} options - Retry options
 * @param {number} options.maxRetries - Maximum number of retry attempts (default: 3)
 * @param {number} options.initialDelay - Initial delay in milliseconds (default: 1000)
 * @param {number} options.maxDelay - Maximum delay in milliseconds (default: 30000)
 * @param {number} options.backoffMultiplier - Multiplier for exponential backoff (default: 2)
 * @param {Function} options.shouldRetry - Custom function to determine if error should be retried
 * @returns {Promise<any>} - Result of the function call
 * @throws {Error} - Last error if all retries fail
 */
export async function retryWithBackoff(fn, options = {}) {
  const {
    maxRetries = parseInt(process.env.MAX_RETRIES || '3', 10),
    initialDelay = parseInt(process.env.RETRY_INITIAL_DELAY || '1000', 10),
    maxDelay = parseInt(process.env.RETRY_MAX_DELAY || '30000', 10),
    backoffMultiplier = 2,
    shouldRetry: customShouldRetry = shouldRetry
  } = options;

  let lastError;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      // Check if we should retry this error
      if (!customShouldRetry(error)) {
        throw error;
      }
      
      // If this was the last attempt, throw the error
      if (attempt >= maxRetries) {
        throw error;
      }
      
      // Calculate delay with exponential backoff
      let delay = Math.min(
        initialDelay * Math.pow(backoffMultiplier, attempt),
        maxDelay
      );

      // Check for Retry-After header (typically on 429 responses)
      const retryAfterDelay = getRetryAfterDelay(error);
      if (retryAfterDelay !== null) {
        // Use Retry-After delay, but cap at maxDelay
        delay = Math.min(retryAfterDelay, maxDelay);
        console.warn(`Rate limited. Server requested retry after ${retryAfterDelay}ms`);
      }

      // Log rate limit info if available
      const rateLimitInfo = getRateLimitInfo(error);
      if (rateLimitInfo.remaining !== null) {
        console.warn(`Rate limit info: ${rateLimitInfo.remaining}/${rateLimitInfo.limit} remaining`);
      }

      console.warn(
        `Attempt ${attempt + 1}/${maxRetries + 1} failed: ${error.message}. ` +
        `Retrying in ${delay}ms...`
      );

      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  // This should never be reached, but TypeScript/ESLint might complain
  throw lastError;
}




