// The logo asset set: SVG sources plus PNGs in the shapes places actually ask for.
//
// PNGs are rasterised from the same SVG the site uses, via Playwright, so the
// files in assets/logo can never drift from the mark on the dashboard.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { chromium } from 'playwright';
import { PALETTE, squareSvg, wordmarkSvg } from './template.js';

// Each entry: the file, its pixel size, what goes on it, and how it sits.
//   kind: 'wordmark' | 'square'   theme: 'dark' | 'light'
//   background: paint the theme background (false → transparent PNG)
//   scale: fraction of the canvas the mark may occupy (wordmark: of width)
export const LOGO_FILES = [
  { name: 'hermes-wordmark-dark.svg',  svg: () => wordmarkSvg({ theme: 'dark' }) },
  { name: 'hermes-wordmark-light.svg', svg: () => wordmarkSvg({ theme: 'light' }) },
  { name: 'hermes-square.svg',         svg: () => squareSvg({ theme: 'dark' }) },
  { name: 'favicon.svg',               svg: () => squareSvg({ theme: 'dark' }) },

  { name: 'hermes-wordmark-dark.png',  kind: 'wordmark', theme: 'dark',  width: 2400, height: 520, background: false, scale: 1 },
  { name: 'hermes-wordmark-light.png', kind: 'wordmark', theme: 'light', width: 2400, height: 520, background: false, scale: 1 },

  { name: 'hermes-square-1024.png',       kind: 'square', theme: 'dark',  width: 1024, height: 1024, background: true },
  { name: 'hermes-square-light-1024.png', kind: 'square', theme: 'light', width: 1024, height: 1024, background: true },
  { name: 'hermes-square-512.png',        kind: 'square', theme: 'dark',  width: 512,  height: 512,  background: true },
  { name: 'hermes-thumbnail-256.png',     kind: 'square', theme: 'dark',  width: 256,  height: 256,  background: true },
  { name: 'apple-touch-icon-180.png',     kind: 'square', theme: 'dark',  width: 180,  height: 180,  background: true },
  { name: 'favicon-32.png',               kind: 'square', theme: 'dark',  width: 32,   height: 32,   background: true },
  { name: 'favicon-16.png',               kind: 'square', theme: 'dark',  width: 16,   height: 16,   background: true },

  { name: 'hermes-header-1600x400.png',       kind: 'wordmark', theme: 'dark',  width: 1600, height: 400, background: true, scale: 0.6 },
  { name: 'hermes-header-light-1600x400.png', kind: 'wordmark', theme: 'light', width: 1600, height: 400, background: true, scale: 0.6 },
  { name: 'hermes-social-1280x640.png',       kind: 'wordmark', theme: 'dark',  width: 1280, height: 640, background: true, scale: 0.62 }
];

function pageHtml(spec) {
  const svg = spec.kind === 'square' ? squareSvg({ theme: spec.theme, background: false }) : wordmarkSvg({ theme: spec.theme });
  const bg = spec.background ? (spec.theme === 'light' ? PALETTE.bone : PALETTE.ink) : 'transparent';
  const markWidth = spec.kind === 'square' ? '100%' : `${Math.round(spec.scale * 100)}%`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:${spec.width}px;height:${spec.height}px;background:${bg};overflow:hidden}
    body{display:flex;align-items:center;justify-content:center}
    svg{width:${markWidth};height:auto;max-height:100%;display:block}
  </style></head><body>${svg}</body></html>`;
}

export async function renderLogoSet(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];

  for (const spec of LOGO_FILES.filter(f => f.svg)) {
    fs.writeFileSync(path.join(outDir, spec.name), spec.svg());
    written.push(spec.name);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-logo-'));
  const browser = await chromium.launch();
  try {
    for (const spec of LOGO_FILES.filter(f => !f.svg)) {
      const page = await browser.newPage({ viewport: { width: spec.width, height: spec.height }, deviceScaleFactor: 1 });
      const file = path.join(tmpDir, `${spec.name}.html`);
      fs.writeFileSync(file, pageHtml(spec));
      await page.goto(`file://${file}`, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: path.join(outDir, spec.name), type: 'png', omitBackground: !spec.background });
      await page.close();
      written.push(spec.name);
    }
  } finally {
    await browser.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  return written;
}
