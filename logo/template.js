// The Hermes mark: a terminal prompt, the name, a block cursor.
//
//   > HERMES ▌
//
// Set in JetBrains Mono, the same face the dashboard and the story graphic use
// for their labels, in the story graphic's palette. The font is embedded so the
// SVG stands alone (a logo file that falls back to Courier is not a logo file).
//
// Geometry is in units of the word's font size (100), from JetBrains Mono's
// metrics: 0.6em advance, ~0.73em cap height. Everything else is derived from
// that so a change to one number moves the whole mark consistently.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const FONT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'fonts', 'JetBrainsMono-Variable.woff2');
let fontData = null;
function fontFace() {
  if (fontData === null) fontData = fs.readFileSync(FONT_FILE).toString('base64');
  return `@font-face{font-family:'JBMono';src:url(data:font/woff2;base64,${fontData}) format('woff2');font-weight:100 800}`;
}

export const PALETTE = {
  ink: '#191d24',
  bone: '#f6f5f0',
  sage: '#8c9f88',
  sage600: '#57694f'
};

// Word colour and accent per background.
function colors(theme) {
  return theme === 'light'
    ? { word: PALETTE.ink, accent: PALETTE.sage600, background: PALETTE.bone }
    : { word: PALETTE.bone, accent: PALETTE.sage, background: PALETTE.ink };
}

const SIZE = 100;            // word font size, and the unit for everything below
const ADVANCE = 0.6 * SIZE;  // JetBrains Mono glyph advance
const CAP = 0.73 * SIZE;     // cap height
const TRACK = -0.04 * SIZE;  // letter-spacing on the word
const PROMPT_GAP = 0.3 * SIZE;
const CURSOR_GAP = 0.22 * SIZE;
const CURSOR_W = 0.4 * SIZE;
const PAD = 0.15 * SIZE;

const escapeText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The horizontal wordmark. `cursor: false` gives the static form for places
 * that must not look interactive (print, favicon rows).
 */
export function wordmarkSvg({ theme = 'dark', cursor = true } = {}) {
  const c = colors(theme);
  const promptX = 0;
  const wordX = ADVANCE + PROMPT_GAP;
  const wordW = 6 * ADVANCE + 5 * TRACK;
  const cursorX = wordX + wordW + CURSOR_GAP;
  const width = Math.round((cursor ? cursorX + CURSOR_W : wordX + wordW) + 0);
  const baseline = PAD + CAP;
  const height = Math.round(baseline + PAD);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Hermes">
<style>${fontFace()} text{font-family:'JBMono',ui-monospace,monospace}</style>
<text x="${promptX}" y="${baseline}" font-size="${SIZE}" font-weight="500" fill="${c.accent}">${escapeText('>')}</text>
<text x="${wordX}" y="${baseline}" font-size="${SIZE}" font-weight="700" letter-spacing="${TRACK}" fill="${c.word}">HERMES</text>
${cursor ? `<rect class="cursor" x="${cursorX}" y="${PAD}" width="${CURSOR_W}" height="${CAP}" fill="${c.accent}"/>` : ''}
</svg>`;
}

/**
 * The square mark: the prompt and the first letter, for avatars and app icons.
 * `background: false` yields a transparent tile for platforms that supply
 * their own shape.
 */
export function squareSvg({ theme = 'dark', background = true } = {}) {
  const c = colors(theme);
  const S = 1024;
  const size = 560;                       // font size inside the tile
  const adv = 0.6 * size, cap = 0.73 * size, gap = 0.04 * size;
  const contentW = 2 * adv + gap;
  const x0 = (S - contentW) / 2;
  const baseline = (S + cap) / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" role="img" aria-label="Hermes">
<style>${fontFace()} text{font-family:'JBMono',ui-monospace,monospace}</style>
${background ? `<rect width="${S}" height="${S}" fill="${c.background}"/>` : ''}
<text x="${x0}" y="${baseline}" font-size="${size}" font-weight="500" fill="${c.accent}">${escapeText('>')}</text>
<text x="${x0 + adv + gap}" y="${baseline}" font-size="${size}" font-weight="700" fill="${c.word}">H</text>
</svg>`;
}
