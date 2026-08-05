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

// Character budget for the room chip at scale 1.0. Divided by the page scale so
// the chip stays a roughly constant pixel width - at 1.3x an 18-character chip
// is wide enough to squeeze the description into a narrow column.
const LOCATION_MAX = 18;

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
 * @returns {string}
 */
export function shortLocation(location, scale = 1) {
  const max = Math.round(LOCATION_MAX / scale);
  const text = String(location || '').trim();
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
 * @returns {string} complete HTML document
 */
export function buildPage({ isoDate, events, page, totalPages, totalEvents }) {
  const s = scaleFor(events.length);
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
  background:${C.bone};border-radius:44px;padding:${px(52)} ${px(54)};display:flex;flex-direction:column}
.hd{display:flex;justify-content:space-between;align-items:flex-start;
  border-bottom:3px solid ${C.ink};padding-bottom:${px(26)}}
.hd-title{font-family:'GeneralSans',sans-serif;font-weight:600;font-size:${px(74)};
  line-height:.95;letter-spacing:-.025em;color:${C.ink}}
.hd-sub{font-family:'JBMono',monospace;font-size:${px(21)};letter-spacing:.2em;
  color:${C.inkMuted};margin-top:${px(12)};text-transform:uppercase}
.hd-meta{font-family:'JBMono',monospace;font-size:${px(21)};letter-spacing:.14em;
  color:${C.inkMuted};text-align:right;line-height:1.6}
.body{flex:1;margin-top:${px(8)}}
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
/* Clamp: one verbose caption must not push the rest of the day off the card */
.ev-desc{font-size:${px(25)};color:${C.inkMuted};margin-top:${px(5)};line-height:1.35;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
/* Long locations are truncated in shortLocation() so this stays one clean line */
.ev-room{font-family:'JBMono',monospace;font-size:${px(25)};font-weight:700;color:${C.bone};
  background:${C.sage600};padding:${px(11)} ${px(18)};border-radius:${px(12)};
  align-self:center;flex:none;white-space:nowrap}
.ft{display:flex;justify-content:space-between;font-family:'JBMono',monospace;
  font-size:${px(21)};letter-spacing:.14em;color:${C.inkMuted};
  border-top:3px solid ${C.ink};padding-top:${px(22)}}
</style></head><body>
<div class="sheet">
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
${group.events.map(e => `      <div class="ev">
        ${avatarMarkup(e.club_name)}
        <div class="ev-main">
          <div class="ev-club">@${escapeHtml(e.club_name)}</div>
          ${e.description ? `<div class="ev-desc">${escapeHtml(e.description)}</div>` : ''}
        </div>
        ${e.location ? `<div class="ev-room">${escapeHtml(shortLocation(e.location, s))}</div>` : ''}
      </div>`).join('\n')}
    </div>`).join('\n')}
  </div>
  <div class="ft"><span>@MSJCLUBS</span><span>${page} / ${totalPages}</span></div>
</div>
</body></html>`;
}
