// Retry utility with exponential backoff for handling transient failures

/**
 * Determines if an error should be retried based on error type and status code
 * @param {Error} error - The error to check
 * @returns {boolean} - True if the error should be retried
 */
function shouldRetry(error) {
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
      const delay = Math.min(
        initialDelay * Math.pow(backoffMultiplier, attempt),
        maxDelay
      );
      
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




