// Rate limiter with adaptive delays and circuit breaker pattern

/**
 * Rate limiter class with adaptive delays and circuit breaker
 */
export class RateLimiter {
  constructor(options = {}) {
    // Base delay configuration
    this.baseDelay = options.baseDelay || 1000;
    this.minDelay = options.minDelay || 500;
    this.maxDelay = options.maxDelay || 30000;

    // Adaptive delay multipliers
    this.successMultiplier = options.successMultiplier || 0.9;
    this.failureMultiplier = options.failureMultiplier || 2.0;

    // Circuit breaker configuration
    this.maxConsecutiveFailures = options.maxConsecutiveFailures || 5;
    this.circuitCooldownMs = options.circuitCooldownMs || 60000;

    // State
    this.currentDelay = this.baseDelay;
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.circuitOpen = false;
    this.circuitOpenedAt = null;
    this.lastRequestTime = null;

    // Statistics
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      rateLimitHits: 0,
      circuitBreaks: 0
    };
  }

  /**
   * Waits for the current delay before allowing a request
   * @returns {Promise<void>}
   */
  async waitForSlot() {
    // Check circuit breaker
    if (this.circuitOpen) {
      const timeSinceOpen = Date.now() - this.circuitOpenedAt;
      if (timeSinceOpen < this.circuitCooldownMs) {
        const remainingCooldown = this.circuitCooldownMs - timeSinceOpen;
        console.log(`⚠️  Circuit breaker open - waiting ${Math.round(remainingCooldown / 1000)}s cooldown...`);
        await this.sleep(remainingCooldown);
      }
      // Reset circuit breaker after cooldown
      this.closeCircuit();
    }

    // Wait for current delay if we've made a recent request
    if (this.lastRequestTime) {
      const timeSinceLastRequest = Date.now() - this.lastRequestTime;
      if (timeSinceLastRequest < this.currentDelay) {
        const waitTime = this.currentDelay - timeSinceLastRequest;
        await this.sleep(waitTime);
      }
    }

    this.lastRequestTime = Date.now();
    this.stats.totalRequests++;
  }

  /**
   * Records a successful request - decreases delay
   */
  recordSuccess() {
    this.consecutiveSuccesses++;
    this.consecutiveFailures = 0;
    this.stats.successfulRequests++;

    // Gradually decrease delay on consecutive successes
    if (this.consecutiveSuccesses >= 3) {
      this.currentDelay = Math.max(
        this.minDelay,
        this.currentDelay * this.successMultiplier
      );
    }
  }

  /**
   * Records a failed request - increases delay
   * @param {boolean} isRateLimit - Whether the failure was due to rate limiting
   */
  recordFailure(isRateLimit = false) {
    this.consecutiveFailures++;
    this.consecutiveSuccesses = 0;
    this.stats.failedRequests++;

    if (isRateLimit) {
      this.stats.rateLimitHits++;
    }

    // Increase delay on failure
    this.currentDelay = Math.min(
      this.maxDelay,
      this.currentDelay * this.failureMultiplier
    );

    // Check if circuit should open
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      this.openCircuit();
    }
  }

  /**
   * Records a rate limit response with optional Retry-After value
   * @param {number|null} retryAfterMs - Retry-After header value in milliseconds
   */
  recordRateLimit(retryAfterMs = null) {
    this.recordFailure(true);

    // Use Retry-After if provided and reasonable
    if (retryAfterMs && retryAfterMs > 0 && retryAfterMs <= this.maxDelay) {
      this.currentDelay = Math.max(this.currentDelay, retryAfterMs);
      console.log(`Rate limit hit - using Retry-After delay: ${retryAfterMs}ms`);
    }
  }

  /**
   * Opens the circuit breaker
   */
  openCircuit() {
    if (!this.circuitOpen) {
      this.circuitOpen = true;
      this.circuitOpenedAt = Date.now();
      this.stats.circuitBreaks++;
      console.error(`⚠️  Circuit breaker OPENED after ${this.consecutiveFailures} consecutive failures`);
      console.error(`   Cooling down for ${this.circuitCooldownMs / 1000}s before allowing more requests`);
    }
  }

  /**
   * Closes the circuit breaker
   */
  closeCircuit() {
    if (this.circuitOpen) {
      this.circuitOpen = false;
      this.circuitOpenedAt = null;
      this.consecutiveFailures = 0;
      this.currentDelay = this.baseDelay;
      console.log('✓ Circuit breaker CLOSED - resuming normal operation');
    }
  }

  /**
   * Checks if the circuit is currently open
   * @returns {boolean}
   */
  isCircuitOpen() {
    if (!this.circuitOpen) return false;

    // Check if cooldown has elapsed
    const timeSinceOpen = Date.now() - this.circuitOpenedAt;
    if (timeSinceOpen >= this.circuitCooldownMs) {
      this.closeCircuit();
      return false;
    }

    return true;
  }

  /**
   * Gets the current delay in milliseconds
   * @returns {number}
   */
  getCurrentDelay() {
    return this.currentDelay;
  }

  /**
   * Resets the rate limiter to initial state
   */
  reset() {
    this.currentDelay = this.baseDelay;
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.circuitOpen = false;
    this.circuitOpenedAt = null;
    this.lastRequestTime = null;
  }

  /**
   * Gets rate limiter statistics
   * @returns {Object}
   */
  getStats() {
    return {
      ...this.stats,
      currentDelay: this.currentDelay,
      circuitOpen: this.circuitOpen,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses
    };
  }

  /**
   * Prints statistics to console
   */
  printStats() {
    const stats = this.getStats();
    console.log('\n--- Rate Limiter Statistics ---');
    console.log(`Total requests: ${stats.totalRequests}`);
    console.log(`Successful: ${stats.successfulRequests}`);
    console.log(`Failed: ${stats.failedRequests}`);
    console.log(`Rate limit hits: ${stats.rateLimitHits}`);
    console.log(`Circuit breaks: ${stats.circuitBreaks}`);
    console.log(`Current delay: ${stats.currentDelay}ms`);
    console.log(`Circuit open: ${stats.circuitOpen}`);
  }

  /**
   * Helper to sleep for a given duration
   * @private
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Creates a rate limiter with default or custom options
 * @param {Object} options - Rate limiter options
 * @returns {RateLimiter}
 */
export function createRateLimiter(options = {}) {
  return new RateLimiter(options);
}

/**
 * Creates a rate limiter configured for Instagram scraping
 * @returns {RateLimiter}
 */
export function createInstagramRateLimiter() {
  return new RateLimiter({
    baseDelay: 2000,
    minDelay: 1000,
    maxDelay: 60000,
    maxConsecutiveFailures: 5,
    circuitCooldownMs: 60000
  });
}

/**
 * Creates a rate limiter configured for Claude API calls
 * @returns {RateLimiter}
 */
export function createClaudeRateLimiter() {
  return new RateLimiter({
    baseDelay: 1000,
    minDelay: 500,
    maxDelay: 30000,
    maxConsecutiveFailures: 3,
    circuitCooldownMs: 30000
  });
}
