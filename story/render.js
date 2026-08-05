// HTML -> PNG via Playwright.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { chromium } from 'playwright';
import { WIDTH, HEIGHT } from './template.js';

/**
 * Renders HTML pages to PNG buffers at story dimensions.
 *
 * Each page is written to a temp file and opened with goto() rather than passed
 * to setContent(). setContent leaves the document on an about:blank origin, which
 * blocks the file:// requests for our fonts and avatars - they fail silently and
 * the page renders in fallback system sans with no error anywhere.
 *
 * @param {Array<string>} htmlPages
 * @returns {Promise<Array<Buffer>>} PNG buffer per page
 */
export async function renderPages(htmlPages) {
  if (!htmlPages.length) return [];

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-story-'));
  const browser = await chromium.launch();

  try {
    const page = await browser.newPage({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 1
    });

    const buffers = [];
    for (const [index, html] of htmlPages.entries()) {
      const file = path.join(tmpDir, `page-${index}.html`);
      fs.writeFileSync(file, html);

      await page.goto(`file://${file}`, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);

      buffers.push(await page.screenshot({ type: 'png' }));
    }
    return buffers;
  } finally {
    await browser.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Reports which @font-face rules actually resolved. Used by tests to guard the
 * setContent regression described above.
 * @param {string} html
 * @returns {Promise<Array<{family: string, status: string}>>}
 */
export async function inspectFonts(html) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-font-'));
  const file = path.join(tmpDir, 'page.html');
  fs.writeFileSync(file, html);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
    await page.goto(`file://${file}`, { waitUntil: 'networkidle' });
    return await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts].map(f => ({ family: f.family, status: f.status }));
    });
  } finally {
    await browser.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
