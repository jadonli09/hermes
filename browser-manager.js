// Browser manager for Playwright lifecycle management
import { chromium } from 'playwright';

/**
 * Default browser configuration
 */
const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

/**
 * Browser manager class for managing Playwright browser instances
 */
export class BrowserManager {
  constructor() {
    this.browser = null;
    this.contexts = [];
  }

  /**
   * Launches a Playwright browser instance
   * @param {Object} options - Browser launch options
   * @param {boolean} options.headless - Whether to run in headless mode
   * @returns {Promise<Browser>} - Playwright browser instance
   */
  async launch(options = {}) {
    const { headless = true } = options;

    console.log('\n--- Launching Browser ---');
    this.browser = await chromium.launch({
      headless,
      args: ['--disable-blink-features=AutomationControlled']
    });

    console.log('✓ Browser launched');
    return this.browser;
  }

  /**
   * Creates a new browser context with optional custom settings
   * @param {Object} options - Context options
   * @param {Object} options.viewport - Viewport dimensions
   * @param {string} options.userAgent - User agent string
   * @param {Object} options.storageState - Storage state for session persistence
   * @returns {Promise<BrowserContext>} - Playwright browser context
   */
  async createContext(options = {}) {
    if (!this.browser) {
      throw new Error('Browser not launched. Call launch() first.');
    }

    const {
      viewport = DEFAULT_VIEWPORT,
      userAgent = DEFAULT_USER_AGENT,
      storageState = undefined
    } = options;

    const context = await this.browser.newContext({
      viewport,
      userAgent,
      storageState
    });

    this.contexts.push(context);
    return context;
  }

  /**
   * Creates a new page in the given context or creates a new context first
   * @param {BrowserContext} context - Optional browser context
   * @returns {Promise<Page>} - Playwright page instance
   */
  async createPage(context = null) {
    if (!context) {
      context = await this.createContext();
    }
    return await context.newPage();
  }

  /**
   * Gets the storage state from a context for session persistence
   * @param {BrowserContext} context - Browser context
   * @returns {Promise<Object>} - Storage state object
   */
  async getStorageState(context) {
    return await context.storageState();
  }

  /**
   * Creates multiple browser contexts for parallel processing
   * @param {number} count - Number of contexts to create
   * @param {Object} sharedStorageState - Shared storage state (e.g., login cookies)
   * @param {number} staggerDelay - Delay between context creation (ms)
   * @returns {Promise<Array<{context: BrowserContext, page: Page}>>} - Array of context/page pairs
   */
  async createParallelContexts(count, sharedStorageState = null, staggerDelay = 2000) {
    const results = [];

    for (let i = 0; i < count; i++) {
      if (i > 0 && staggerDelay > 0) {
        console.log(`  Waiting ${staggerDelay}ms before creating worker ${i + 1}...`);
        await new Promise(resolve => setTimeout(resolve, staggerDelay));
      }

      const context = await this.createContext({
        storageState: sharedStorageState
      });
      const page = await context.newPage();

      results.push({ context, page });
      console.log(`  ✓ Created worker ${i + 1}/${count}`);
    }

    return results;
  }

  /**
   * Closes a specific context
   * @param {BrowserContext} context - Context to close
   */
  async closeContext(context) {
    const index = this.contexts.indexOf(context);
    if (index !== -1) {
      this.contexts.splice(index, 1);
    }
    await context.close();
  }

  /**
   * Closes all contexts
   */
  async closeAllContexts() {
    for (const context of this.contexts) {
      try {
        await context.close();
      } catch (error) {
        console.warn(`Error closing context: ${error.message}`);
      }
    }
    this.contexts = [];
  }

  /**
   * Closes the browser and all contexts
   */
  async close() {
    console.log('\n--- Cleaning Up ---');
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.contexts = [];
      console.log('✓ Browser closed');
    }
  }

  /**
   * Checks if the browser is still connected
   * @returns {boolean} - True if browser is connected
   */
  isConnected() {
    return this.browser && this.browser.isConnected();
  }
}

/**
 * Creates a simple browser manager and launches browser
 * @param {Object} options - Options passed to launch()
 * @returns {Promise<BrowserManager>} - Initialized browser manager
 */
export async function createBrowserManager(options = {}) {
  const manager = new BrowserManager();
  await manager.launch(options);
  return manager;
}
