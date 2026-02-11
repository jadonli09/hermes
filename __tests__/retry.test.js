import { jest } from '@jest/globals';
import { retryWithBackoff, shouldRetry } from '../utils/retry.js';

describe('shouldRetry', () => {
  describe('network errors - should retry', () => {
    it('should retry on ECONNRESET', () => {
      const error = new Error('ECONNRESET: Connection reset');
      expect(shouldRetry(error)).toBe(true);
    });

    it('should retry on ETIMEDOUT', () => {
      const error = new Error('ETIMEDOUT: Connection timed out');
      expect(shouldRetry(error)).toBe(true);
    });

    it('should retry on ENOTFOUND', () => {
      const error = new Error('ENOTFOUND: DNS lookup failed');
      expect(shouldRetry(error)).toBe(true);
    });

    it('should retry on network errors', () => {
      const error = new Error('network error occurred');
      expect(shouldRetry(error)).toBe(true);
    });

    it('should retry on timeout errors', () => {
      const error = new Error('Request timeout');
      expect(shouldRetry(error)).toBe(true);
    });
  });

  describe('HTTP status codes', () => {
    it('should retry on 429 (rate limit)', () => {
      const error = new Error('Rate limited');
      error.status = 429;
      expect(shouldRetry(error)).toBe(true);
    });

    it('should retry on 500 (server error)', () => {
      const error = new Error('Internal server error');
      error.status = 500;
      expect(shouldRetry(error)).toBe(true);
    });

    it('should retry on 502 (bad gateway)', () => {
      const error = new Error('Bad gateway');
      error.status = 502;
      expect(shouldRetry(error)).toBe(true);
    });

    it('should retry on 503 (service unavailable)', () => {
      const error = new Error('Service unavailable');
      error.status = 503;
      expect(shouldRetry(error)).toBe(true);
    });

    it('should NOT retry on 400 (bad request)', () => {
      const error = new Error('Bad request');
      error.status = 400;
      expect(shouldRetry(error)).toBe(false);
    });

    it('should NOT retry on 401 (unauthorized)', () => {
      const error = new Error('Unauthorized');
      error.status = 401;
      expect(shouldRetry(error)).toBe(false);
    });

    it('should NOT retry on 403 (forbidden)', () => {
      const error = new Error('Forbidden');
      error.status = 403;
      expect(shouldRetry(error)).toBe(false);
    });

    it('should NOT retry on 404 (not found)', () => {
      const error = new Error('Not found');
      error.status = 404;
      expect(shouldRetry(error)).toBe(false);
    });

    it('should handle statusCode property', () => {
      const error = new Error('Rate limited');
      error.statusCode = 429;
      expect(shouldRetry(error)).toBe(true);
    });

    it('should handle response.status property', () => {
      const error = new Error('Server error');
      error.response = { status: 500 };
      expect(shouldRetry(error)).toBe(true);
    });
  });

  describe('authentication errors - should NOT retry', () => {
    it('should NOT retry on authentication errors', () => {
      const error = new Error('authentication failed');
      expect(shouldRetry(error)).toBe(false);
    });

    it('should NOT retry on unauthorized errors', () => {
      const error = new Error('unauthorized access');
      expect(shouldRetry(error)).toBe(false);
    });

    it('should NOT retry on forbidden errors', () => {
      const error = new Error('forbidden resource');
      expect(shouldRetry(error)).toBe(false);
    });

    it('should NOT retry on not found errors', () => {
      const error = new Error('resource not found');
      expect(shouldRetry(error)).toBe(false);
    });

    it('should NOT retry on 404 message errors', () => {
      const error = new Error('404 page not found');
      expect(shouldRetry(error)).toBe(false);
    });
  });

  describe('unknown errors - should retry by default', () => {
    it('should retry on unknown errors', () => {
      const error = new Error('Something went wrong');
      expect(shouldRetry(error)).toBe(true);
    });

    it('should retry on empty error', () => {
      const error = new Error();
      expect(shouldRetry(error)).toBe(true);
    });
  });
});

describe('retryWithBackoff', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('successful execution', () => {
    it('should return result on first success', async () => {
      const fn = jest.fn().mockResolvedValue('success');

      const result = await retryWithBackoff(fn, { maxRetries: 3 });

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should succeed after retries', async () => {
      const fn = jest.fn()
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockRejectedValueOnce(new Error('ETIMEDOUT'))
        .mockResolvedValue('success');

      const promise = retryWithBackoff(fn, {
        maxRetries: 3,
        initialDelay: 100,
      });

      // Advance timers for each retry
      await jest.advanceTimersByTimeAsync(100); // First retry delay
      await jest.advanceTimersByTimeAsync(200); // Second retry delay (100 * 2)

      const result = await promise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });

  describe('retry behavior', () => {
    it('should retry on network errors', async () => {
      const fn = jest.fn()
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValue('success');

      const promise = retryWithBackoff(fn, {
        maxRetries: 3,
        initialDelay: 100,
      });

      await jest.advanceTimersByTimeAsync(100);
      const result = await promise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should retry on 429 rate limit', async () => {
      const error = new Error('Rate limited');
      error.status = 429;

      const fn = jest.fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValue('success');

      const promise = retryWithBackoff(fn, {
        maxRetries: 3,
        initialDelay: 100,
      });

      await jest.advanceTimersByTimeAsync(100);
      const result = await promise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should NOT retry on non-retryable errors', async () => {
      const error = new Error('Bad request');
      error.status = 400;

      const fn = jest.fn().mockRejectedValue(error);

      await expect(retryWithBackoff(fn, { maxRetries: 3 }))
        .rejects.toThrow('Bad request');

      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('max retries exceeded', () => {
    it('should throw after max retries', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('ECONNRESET'));

      const promise = retryWithBackoff(fn, {
        maxRetries: 2,
        initialDelay: 100,
      });

      // Add catch to prevent unhandled rejection warning
      promise.catch(() => {});

      // Advance through all retries
      await jest.advanceTimersByTimeAsync(100); // First retry
      await jest.advanceTimersByTimeAsync(200); // Second retry

      await expect(promise).rejects.toThrow('ECONNRESET');
      expect(fn).toHaveBeenCalledTimes(3); // Initial + 2 retries
    });

    it('should use default maxRetries of 3', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('timeout'));

      const promise = retryWithBackoff(fn, {
        initialDelay: 100,
      });

      // Add catch to prevent unhandled rejection warning
      promise.catch(() => {});

      // Advance through all retries
      await jest.advanceTimersByTimeAsync(100);
      await jest.advanceTimersByTimeAsync(200);
      await jest.advanceTimersByTimeAsync(400);

      await expect(promise).rejects.toThrow('timeout');
      expect(fn).toHaveBeenCalledTimes(4); // Initial + 3 retries
    });
  });

  describe('exponential backoff', () => {
    it('should use exponential backoff', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('network error'));

      const promise = retryWithBackoff(fn, {
        maxRetries: 3,
        initialDelay: 100,
        backoffMultiplier: 2,
      });

      // Add catch to prevent unhandled rejection warning
      promise.catch(() => {});

      // Check delays: 100, 200, 400
      await jest.advanceTimersByTimeAsync(100);
      expect(fn).toHaveBeenCalledTimes(2);

      await jest.advanceTimersByTimeAsync(200);
      expect(fn).toHaveBeenCalledTimes(3);

      await jest.advanceTimersByTimeAsync(400);
      expect(fn).toHaveBeenCalledTimes(4);

      await expect(promise).rejects.toThrow();
    });

    it('should respect maxDelay', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('network error'));

      const promise = retryWithBackoff(fn, {
        maxRetries: 5,
        initialDelay: 1000,
        maxDelay: 2000,
        backoffMultiplier: 2,
      });

      // Add catch to prevent unhandled rejection warning
      promise.catch(() => {});

      // First delay: 1000
      await jest.advanceTimersByTimeAsync(1000);
      expect(fn).toHaveBeenCalledTimes(2);

      // Second delay: 2000 (capped at maxDelay)
      await jest.advanceTimersByTimeAsync(2000);
      expect(fn).toHaveBeenCalledTimes(3);

      // Third delay: 2000 (still capped)
      await jest.advanceTimersByTimeAsync(2000);
      expect(fn).toHaveBeenCalledTimes(4);

      // Clean up
      await jest.runAllTimersAsync();
      await expect(promise).rejects.toThrow();
    });
  });

  describe('custom shouldRetry function', () => {
    it('should use custom shouldRetry function', async () => {
      const customShouldRetry = jest.fn().mockReturnValue(false);
      const fn = jest.fn().mockRejectedValue(new Error('Custom error'));

      await expect(retryWithBackoff(fn, {
        maxRetries: 3,
        shouldRetry: customShouldRetry,
      })).rejects.toThrow('Custom error');

      expect(customShouldRetry).toHaveBeenCalled();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry when custom shouldRetry returns true', async () => {
      const customShouldRetry = jest.fn().mockReturnValue(true);
      const fn = jest.fn()
        .mockRejectedValueOnce(new Error('Custom error'))
        .mockResolvedValue('success');

      const promise = retryWithBackoff(fn, {
        maxRetries: 3,
        initialDelay: 100,
        shouldRetry: customShouldRetry,
      });

      await jest.advanceTimersByTimeAsync(100);
      const result = await promise;

      expect(result).toBe('success');
      expect(customShouldRetry).toHaveBeenCalled();
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe('logging', () => {
    it('should log retry attempts', async () => {
      const fn = jest.fn()
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValue('success');

      const promise = retryWithBackoff(fn, {
        maxRetries: 3,
        initialDelay: 100,
      });

      await jest.advanceTimersByTimeAsync(100);
      await promise;

      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Attempt 1/4 failed')
      );
    });
  });
});
