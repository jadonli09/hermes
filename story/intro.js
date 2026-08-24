// The one-time introduction story: what Hermes is, shown in the same visual
// system as the daily graphic so followers recognise the format from day one.
//
// Copy rules: short, natural, and no em dashes. The page should read like a
// person wrote it, and most of it is a picture of what the daily story looks
// like rather than text about it.
import path from 'path';
import { fileURLToPath } from 'url';
import { escapeHtml, WIDTH, HEIGHT } from './template.js';
import { monogram } from './avatars.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');

const SAFE_TOP = 250;
const SAFE_BOTTOM = 250;

const C = {
  sage600: '#57694f', sage400: '#8c9f88', sage200: '#cdd4c6', sage100: '#e2e5dd',
  bone: '#f6f5f0', ink: '#191d24', inkMuted: '#5c6570'
};

// Sample rows, so the intro shows the format instead of describing it
const SAMPLES = [
  { time: 'Lunch', club: 'msjbio', desc: 'Weekly meeting, new members welcome', room: 'B21' },
  { time: 'After School', club: 'msjrobotics', desc: 'Build session for the fall scrimmage', room: 'C12' }
];

/**
 * Renders the introduction page.
 * @returns {string} complete HTML document
 */
export function buildIntroPage() {
  const s = 1.25;
  const px = (v) => `${(v * s).toFixed(1)}px`;

  const sampleRows = SAMPLES.map(sample => `      <div class="grp">
        <div class="grp-h"><span class="grp-t">${escapeHtml(sample.time)}</span><span class="grp-rule"></span></div>
        <div class="ev">
          <div class="pic mono">${escapeHtml(monogram(sample.club))}</div>
          <div class="ev-main">
            <div class="ev-club">@${escapeHtml(sample.club)}</div>
            <div class="ev-desc">${escapeHtml(sample.desc)}</div>
          </div>
          <div class="ev-room">${escapeHtml(sample.room)}</div>
        </div>
      </div>`).join('\n');

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
.body{flex:1;margin-top:${px(8)};display:flex;flex-direction:column}
.intro{font-size:${px(30)};line-height:1.45;color:${C.ink};margin-top:${px(36)};
  max-width:${px(560)}}
.intro b{font-weight:700}
.sample{margin-top:${px(40)}}
.sample-label{font-family:'JBMono',monospace;font-size:${px(21)};font-weight:700;
  letter-spacing:.2em;color:${C.inkMuted};text-transform:uppercase}
.sample-card{margin-top:${px(16)};border:2px dashed ${C.sage400};border-radius:${px(24)};
  padding:${px(10)} ${px(28)} ${px(24)}}
.grp{margin-top:${px(22)}}
.grp-h{display:flex;align-items:center;gap:${px(18)};margin-bottom:${px(4)}}
.grp-t{font-family:'JBMono',monospace;font-size:${px(20)};font-weight:700;letter-spacing:.2em;
  color:${C.sage600};text-transform:uppercase;white-space:nowrap}
.grp-rule{flex:1;height:1px;background:${C.sage200}}
.ev{display:flex;gap:${px(22)};padding:${px(16)} 0;align-items:center}
.pic{width:${px(66)};height:${px(66)};flex:none;border-radius:50%;
  background:${C.sage100};box-shadow:0 0 0 ${px(3)} ${C.bone},0 0 0 ${px(4.5)} ${C.sage200}}
.mono{background:${C.sage400};color:${C.bone};display:grid;place-items:center;
  font-family:'GeneralSans',sans-serif;font-weight:600;font-size:${px(28)}}
.ev-main{flex:1;min-width:0}
.ev-club{font-family:'GeneralSans',sans-serif;font-weight:600;font-size:${px(29)};
  color:${C.ink};letter-spacing:-.01em}
.ev-desc{font-size:${px(22)};color:${C.inkMuted};margin-top:${px(3)};line-height:1.35}
.ev-room{font-family:'JBMono',monospace;font-size:${px(22)};font-weight:700;color:${C.bone};
  background:${C.sage600};padding:${px(10)} ${px(16)};border-radius:${px(11)};
  align-self:center;flex:none;white-space:nowrap}
.outro{font-size:${px(28)};line-height:1.45;color:${C.ink};margin-top:auto;
  padding-top:${px(30)}}
.ft{display:flex;justify-content:space-between;font-family:'JBMono',monospace;
  font-size:${px(21)};letter-spacing:.14em;color:${C.inkMuted};
  border-top:3px solid ${C.ink};padding-top:${px(22)};margin-top:${px(30)}}
</style></head><body>
<div class="sheet">
  <div class="hd">
    <div>
      <div class="hd-title">Meet<br>Hermes</div>
      <div class="hd-sub">New from @msjclubs</div>
    </div>
    <div class="hd-meta">MSJHS<br>DAILY</div>
  </div>
  <div class="body">
    <p class="intro">Every club posts in its own corner of Instagram. <b>Hermes reads them all</b> and puts the day's meetings in one story: who's meeting, when, and where.</p>
    <div class="sample">
      <span class="sample-label">What it looks like</span>
      <div class="sample-card">
${sampleRows}
      </div>
    </div>
    <p class="outro">A new story every school morning. Find your club and just show up.</p>
  </div>
  <div class="ft"><span>@MSJCLUBS</span><span>INTRO</span></div>
</div>
</body></html>`;
}
