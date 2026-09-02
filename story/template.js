// Builds the HTML for one story page.
//
// Design tokens come from the MSJ ASB site so the story matches the school's
// existing identity. See docs/superpowers/specs/2026-08-04-daily-story-graphic-design.md
import path from 'path';
import { fileURLToPath } from 'url';
import { scaleFor, groupByTime } from './paginate.js';
import { avatarPath, monogram } from './avatars.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');

export const WIDTH = 1080;
export const HEIGHT = 1920;

// Instagram overlays its own chrome on the top and bottom of a story
const SAFE_TOP = 250;
const SAFE_BOTTOM = 250;

// The card is a fixed box between those two margins. Everything drawn inside it
// scales with the page's type scale, so this is the whole height budget.
export const SHEET_HEIGHT = HEIGHT - SAFE_TOP - SAFE_BOTTOM;

const C = {
  sage600: '#57694f', sage400: '#8c9f88', sage200: '#cdd4c6', sage100: '#e2e5dd',
  bone: '#f6f5f0', ink: '#191d24', inkMuted: '#5c6570'
};

/**
 * Descriptions originate in Instagram captions, so they can contain markup
 * characters. Escape before interpolation.
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * How much of each event to show, given how many share the page.
 *
 * A quiet day leaves most of the card empty, so truncating anything there is
 * pure loss - show the whole description and the whole location. Density only
 * matters once events are competing for the same space.
 *
 * @param {number} count - Events on this page
 * @returns {{descLines: number, locationMax: number|null}} locationMax null
 *   means show the location in full and let the chip wrap
 */
export function densityFor(count) {
  if (count <= 2) return { descLines: 5, locationMax: null };
  if (count <= 4) return { descLines: 3, locationMax: 24 };
  return { descLines: 2, locationMax: 18 };
}

/**
 * The type scale at which a page's content would fit its card.
 *
 * Every measurement inside the card - padding, header, event rows, the footer -
 * is a multiple of the page's scale, so at scale s the content occupies c*s and
 * the chrome around it k*s, leaving SHEET_HEIGHT - k*s for the content. Solving
 * c*s' = SHEET_HEIGHT - k*s' for s' gives the scale that just fits, from a
 * single measurement of an overflowing page.
 *
 * The result is nudged half a percent under that exact fit: text reflows as it
 * shrinks, and landing exactly on the boundary invites another render pass.
 *
 * @param {number} scale - Scale the measurements were taken at
 * @param {number} available - Height the content had to fill, in px
 * @param {number} content - Height the content actually wanted, in px
 * @returns {number} a smaller scale, or the same one if nothing overflowed
 */
export function scaleToFit(scale, available, content) {
  if (content <= available) return scale;
  const wanted = (SHEET_HEIGHT - available) + content;
  return (SHEET_HEIGHT * scale / wanted) * 0.995;
}

/**
 * Locations render as bare room codes: "C12", never "Room C12". The extraction
 * prompt asks for the code alone, but rows written before that rule (and the
 * odd slip) still carry a prefix, so it is stripped again at render time.
 *
 * Only a prefix followed by a plain code is stripped - "Band Room" and
 * "Room of Requirement" pass through untouched.
 *
 * @param {string} location
 * @returns {string}
 */
export function normalizeLocation(location) {
  const text = String(location || '').trim();
  const match = text.match(/^(?:room|rm\.?)[:\s]\s*([a-z]?\d+[a-z]?)$/i);
  return match ? match[1].toUpperCase() : text;
}

/**
 * Shortens a location to fit the room chip.
 *
 * Locations are usually codes (B17, A-Wing) but Claude sometimes extracts a
 * whole phrase ("MSJHS Campus - Booth Map Locations"). Truncating here keeps the
 * chip a predictable single line; clamping it in CSS lets text escape the
 * chip's background.
 *
 * @param {string} location
 * @param {number} [scale] - Page type scale; larger type gets fewer characters
 * @param {number|null} [locationMax] - Character budget, or null for no limit
 * @returns {string}
 */
export function shortLocation(location, scale = 1, locationMax = 18) {
  const text = String(location || '').trim();
  if (locationMax === null) return text;

  // Divided by scale so the chip holds a roughly constant pixel width - at 1.3x
  // an 18-character chip is wide enough to squeeze the description into a
  // narrow column.
  const max = Math.round(locationMax / scale);
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + '…';
}

/**
 * Formats an ISO date as the two-line story heading.
 * @param {string} isoDate - YYYY-MM-DD
 * @returns {{weekday: string, monthDay: string}}
 */
export function formatHeading(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return {
    weekday: date.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }),
    monthDay: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  };
}

function avatarMarkup(handle, px) {
  const file = avatarPath(handle);
  if (file) {
    return `<img class="pic" src="file://${file}" alt="">`;
  }
  return `<div class="pic mono">${escapeHtml(monogram(handle))}</div>`;
}

/**
 * Renders one page of the story.
 *
 * @param {Object} options
 * @param {string} options.isoDate - YYYY-MM-DD
 * @param {Array<Object>} options.events - Events on this page
 * @param {number} options.page - 1-indexed
 * @param {number} options.totalPages
 * @param {number} options.totalEvents - Across all pages, for the header count
 * @param {Array<Object>} [options.recurring] - Weekly meetings happening today,
 *   rendered as a compact strip above the footer. Passed on the last page only.
 * @param {number} [options.scale] - Type scale override. Omitted, the page sizes
 *   itself from its event count; the renderer passes a smaller one when that
 *   natural size overflows the card.
 * @returns {string} complete HTML document
 */
export function buildPage({ isoDate, events, page, totalPages, totalEvents, recurring, scale }) {
  const s = scale ?? scaleFor(events.length);
  const { descLines, locationMax } = densityFor(events.length);
  const stackLocation = locationMax === null;
  const px = (v) => `${(v * s).toFixed(1)}px`;
  const { weekday, monthDay } = formatHeading(isoDate);
  const groups = groupByTime(events);
  const count = totalEvents ?? events.length;

  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:'GeneralSans';src:url('file://${FONT_DIR}/GeneralSans-Variable.woff2')format('woff2');font-weight:200 700}
@font-face{font-family:'Satoshi';src:url('file://${FONT_DIR}/Satoshi-Variable.woff2')format('woff2');font-weight:300 900}
@font-face{font-family:'JBMono';src:url('file://${FONT_DIR}/JetBrainsMono-Variable.woff2')format('woff2');font-weight:100 800}
*{margin:0;padding:0;box-sizing:border-box}
body{width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;background:${C.sage600};
  font-family:'Satoshi',sans-serif;-webkit-font-smoothing:antialiased}
.sheet{position:absolute;top:${SAFE_TOP}px;bottom:${SAFE_BOTTOM}px;left:56px;right:56px;
  background:${C.bone};border-radius:44px;padding:${px(52)} ${px(54)};display:flex;flex-direction:column;
  overflow:hidden}
.hd{display:flex;justify-content:space-between;align-items:flex-start;
  border-bottom:3px solid ${C.ink};padding-bottom:${px(26)};flex:none}
.hd-title{font-family:'GeneralSans',sans-serif;font-weight:600;font-size:${px(74)};
  line-height:.95;letter-spacing:-.025em;color:${C.ink}}
.hd-sub{font-family:'JBMono',monospace;font-size:${px(21)};letter-spacing:.2em;
  color:${C.inkMuted};margin-top:${px(12)};text-transform:uppercase}
.hd-meta{font-family:'JBMono',monospace;font-size:${px(21)};letter-spacing:.14em;
  color:${C.inkMuted};text-align:right;line-height:1.6}
/* The events column is the only part of the card allowed to give: it absorbs
   whatever height is left over, and clips rather than growing the card. Without
   min-height:0 a flex item refuses to shrink below its content, which pushes the
   strip and the footer clean off the bottom of the card. */
.body{flex:1;min-height:0;overflow:hidden;margin-top:${px(8)}}
.grp{margin-top:${px(34)}}
.grp-h{display:flex;align-items:center;gap:${px(18)};margin-bottom:${px(6)}}
.grp-t{font-family:'JBMono',monospace;font-size:${px(22)};font-weight:700;letter-spacing:.2em;
  color:${C.sage600};text-transform:uppercase;white-space:nowrap}
.grp-rule{flex:1;height:1px;background:${C.sage200}}
.ev{display:flex;gap:${px(24)};padding:${px(22)} 0;border-bottom:1px solid ${C.sage100};
  align-items:center}
.ev:last-child{border-bottom:none}
.pic{width:${px(78)};height:${px(78)};flex:none;border-radius:50%;object-fit:cover;
  background:${C.sage100};box-shadow:0 0 0 ${px(3)} ${C.bone},0 0 0 ${px(4.5)} ${C.sage200}}
.mono{background:${C.sage400};color:${C.bone};display:grid;place-items:center;
  font-family:'GeneralSans',sans-serif;font-weight:600;font-size:${px(34)}}
.ev-main{flex:1;min-width:0}
.ev-club{font-family:'GeneralSans',sans-serif;font-weight:600;font-size:${px(34)};
  color:${C.ink};letter-spacing:-.01em}
/* Line budget follows how many events share the card: a quiet day shows the
   whole description, a busy one clamps so no single caption crowds the rest */
.ev-desc{font-size:${px(25)};color:${C.inkMuted};margin-top:${px(5)};line-height:1.35;
  overflow-wrap:break-word;
  display:-webkit-box;-webkit-line-clamp:${descLines};-webkit-box-orient:vertical;overflow:hidden}
.ev-club{overflow-wrap:break-word}
/* A busy page puts the room code beside the text as a compact chip. A quiet
   page has spare height but the same width, so a side chip would only starve
   the description - stack it underneath instead and show the location in full. */
.ev-room{font-family:'JBMono',monospace;font-size:${px(25)};font-weight:700;color:${C.bone};
  background:${C.sage600};padding:${px(11)} ${px(18)};border-radius:${px(12)};
  line-height:1.3;text-align:center}
.ev-room.beside{align-self:center;flex:none;white-space:nowrap}
.ev-room.below{display:inline-block;margin-top:${px(14)};text-align:left;
  overflow-wrap:break-word}
.ft{display:flex;justify-content:space-between;font-family:'JBMono',monospace;
  font-size:${px(21)};letter-spacing:.14em;color:${C.inkMuted};
  border-top:3px solid ${C.ink};padding-top:${px(22)};flex:none}
/* Standing weekly meetings ride along as a footnote, deliberately quieter than
   the day's events: they repeat every week and must not crowd what is new. */
.rec{border-top:1px solid ${C.sage200};padding-top:${px(16)};margin-bottom:${px(18)};flex:none}
.rec-t{font-family:'JBMono',monospace;font-size:${px(18)};font-weight:700;
  letter-spacing:.2em;color:${C.sage600};text-transform:uppercase;margin-bottom:${px(8)}}
.rec-row{display:flex;align-items:baseline;gap:${px(12)};font-size:${px(22)};
  color:${C.inkMuted};line-height:1.6;white-space:nowrap;overflow:hidden}
/* A long club name shortens with an ellipsis rather than shoving the room code
   off the end of the row - the room is the reason the line is there. */
.rec-club{font-family:'GeneralSans',sans-serif;font-weight:600;color:${C.ink};
  min-width:0;overflow:hidden;text-overflow:ellipsis}
.rec-dot,.rec-time,.rec-room{flex:none}
.rec-dot{color:${C.sage400}}
.rec-room{font-family:'JBMono',monospace;font-weight:700;color:${C.sage600}}
</style></head><body>
<div class="sheet" data-scale="${s}">
  <div class="hd">
    <div>
      <div class="hd-title">${escapeHtml(weekday)}<br>${escapeHtml(monthDay)}</div>
      <div class="hd-sub">Club schedule</div>
    </div>
    <div class="hd-meta">MSJHS<br>${count} EVENT${count === 1 ? '' : 'S'}</div>
  </div>
  <div class="body">
${groups.map(group => `    <div class="grp">
      <div class="grp-h"><span class="grp-t">${escapeHtml(group.time)}</span><span class="grp-rule"></span></div>
${group.events.map(e => {
      const location = normalizeLocation(e.location);
      return `      <div class="ev">
        ${avatarMarkup(e.club_name)}
        <div class="ev-main">
          <div class="ev-club">${e.recurring ? '' : '@'}${escapeHtml(e.club_name)}</div>
          ${e.description ? `<div class="ev-desc">${escapeHtml(e.description)}</div>` : ''}
          ${location && stackLocation ? `<div class="ev-room below">${escapeHtml(location)}</div>` : ''}
        </div>
        ${location && !stackLocation ? `<div class="ev-room beside">${escapeHtml(shortLocation(location, s, locationMax))}</div>` : ''}
      </div>`;
    }).join('\n')}
    </div>`).join('\n')}
  </div>
${recurring && recurring.length ? `  <div class="rec">
    <div class="rec-t">Every week</div>
${recurring.map(m => `    <div class="rec-row"><span class="rec-club">${escapeHtml(m.club)}</span><span class="rec-dot">·</span><span class="rec-time">${escapeHtml(m.time)}</span><span class="rec-dot">·</span><span class="rec-room">${escapeHtml(normalizeLocation(m.location))}</span></div>`).join('\n')}
  </div>
` : ''}  <div class="ft"><span>@MSJCLUBS</span><span>${page} / ${totalPages}</span></div>
</div>
</body></html>`;
}
