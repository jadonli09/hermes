// HTML -> PNG via Playwright.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { chromium } from 'playwright';
import { WIDTH, HEIGHT, scaleToFit } from './template.js';

// How many times a page may be re-rendered smaller before we stop trying. The
// estimate lands on the first try for ordinary content; the spare passes cover
// text that reflows into a different number of lines on the way down.
const FIT_PASSES = 3;

// A floor on shrinking. Below this the card is legible but cramped, and a page
// that still does not fit is better clipped by the card than shrunk to nothing.
const MIN_SCALE = 0.75;

/**
 * Reads back how much room the events column had and how much it wanted.
 * Runs inside the page, so it must not close over anything.
 */
function measureFit() {
  const sheet = document.querySelector('.sheet');
  const body = document.querySelector('.body');
  return {
    scale: Number(sheet.dataset.scale),
    available: body.clientHeight,
    content: body.scrollHeight
  };
}

/**
 * Opens one browser page at story dimensions and hands the caller a loader.
 *
 * Each page is written to a temp file and opened with goto() rather than passed
 * to setContent(). setContent leaves the document on an about:blank origin, which
 * blocks the file:// requests for our fonts and avatars - they fail silently and
 * the page renders in fallback system sans with no error anywhere.
 *
 * @param {(page: import('playwright').Page, load: (html: string) => Promise<void>) => Promise<any>} fn
 */
async function withStoryPage(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-story-'));
  const browser = await chromium.launch();

  try {
    const page = await browser.newPage({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 1
    });

    let loaded = 0;
    const load = async (html) => {
      const file = path.join(tmpDir, `page-${loaded++}.html`);
      fs.writeFileSync(file, html);
      await page.goto(`file://${file}`, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
    };

    return await fn(page, load);
  } finally {
    await browser.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Renders HTML pages to PNG buffers at story dimensions.
 *
 * @param {Array<string>} htmlPages
 * @returns {Promise<Array<Buffer>>} PNG buffer per page
 */
export async function renderPages(htmlPages) {
  if (!htmlPages.length) return [];

  return withStoryPage(async (page, load) => {
    const buffers = [];
    for (const html of htmlPages) {
      await load(html);
      buffers.push(await page.screenshot({ type: 'png' }));
    }
    return buffers;
  });
}

/**
 * Renders pages, shrinking any whose content overruns its card.
 *
 * A page's type scale is picked from its event count alone, which cannot know
 * how long the captions on it turned out to be. Rather than guess a density
 * that is safe for the worst case and waste the card on every ordinary day,
 * each page is measured after it renders and re-rendered smaller if it did not
 * fit. Only the pages that need it shrink.
 *
 * @param {Array<(scale: number|null) => string>} builders - one per page, called
 *   with null for the page's natural size and a scale to shrink it
 * @returns {Promise<{images: Array<Buffer>, scales: Array<number|null>}>} scales
 *   holds null for a page that fit at its natural size
 */
export async function renderFitted(builders) {
  if (!builders.length) return { images: [], scales: [] };

  return withStoryPage(async (page, load) => {
    const images = [];
    const scales = [];

    for (const build of builders) {
      let scale = null;
      for (let pass = 0; pass <= FIT_PASSES; pass++) {
        await load(build(scale));
        const fit = await page.evaluate(measureFit);

        if (fit.content <= fit.available) break;
        if (pass === FIT_PASSES || scale === MIN_SCALE) break;
        scale = Math.max(MIN_SCALE, scaleToFit(fit.scale, fit.available, fit.content));
      }

      images.push(await page.screenshot({ type: 'png' }));
      scales.push(scale);
    }

    return { images, scales };
  });
}

/**
 * Reports which @font-face rules actually resolved. Used by tests to guard the
 * setContent regression described above.
 * @param {string} html
 * @returns {Promise<Array<{family: string, status: string}>>}
 */
export async function inspectFonts(html) {
  return withStoryPage(async (page, load) => {
    await load(html);
    return page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts].map(f => ({ family: f.family, status: f.status }));
    });
  });
}

/**
 * Reports where the card's parts landed. Used by tests to guard the overflow
 * regressions: nothing in the card may spill past its bottom edge, and no
 * standing-meeting row may push its room code off its right edge.
 * @param {string} html
 * @returns {Promise<Object>} boxes in page coordinates, plus overflow measurements
 */
export async function inspectLayout(html) {
  return withStoryPage(async (page, load) => {
    await load(html);
    return page.evaluate(() => {
      const box = (selector) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const { top, bottom, height } = el.getBoundingClientRect();
        return { top, bottom, height };
      };
      const body = document.querySelector('.body');
      return {
        sheet: box('.sheet'),
        header: box('.hd'),
        body: box('.body'),
        recurring: box('.rec'),
        footer: box('.ft'),
        overflow: body.scrollHeight - body.clientHeight,
        strip: [...document.querySelectorAll('.rec-row')].map(row => {
          const room = row.querySelector('.rec-room');
          return {
            overflow: row.scrollWidth - row.clientWidth,
            roomVisible: room.getBoundingClientRect().right <= row.getBoundingClientRect().right
          };
        })
      };
    });
  });
}
