import { initialState, reduce, reduceAll } from './state.js';
import { estimateCost } from './pricing.js';

let state = initialState();
let settings = null;
let source = null;

const $ = (id) => document.getElementById(id);

const api = async (path, options) => {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
};

const escape = (value) => String(value ?? '').replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const usd = (n) => n == null ? '—' : `$${n.toFixed(n < 10 ? 2 : 1)}`;
const kilo = (n) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---- tabs

for (const button of document.querySelectorAll('#tabs button')) {
  button.addEventListener('click', () => {
    for (const other of document.querySelectorAll('#tabs button')) {
      other.classList.remove('active');
      other.removeAttribute('aria-current');
    }
    for (const tab of document.querySelectorAll('.tab')) tab.classList.remove('active');

    button.classList.add('active');
    button.setAttribute('aria-current', 'page');
    $(`tab-${button.dataset.tab}`).classList.add('active');

    if (button.dataset.tab === 'history') loadHistory();
    if (button.dataset.tab === 'settings') loadSettings();
  });
}

// ---- run tab

function renderRollcall() {
  // Idle shows every tracked account unfilled, so the strip reads as a roster
  // before a run and as progress during one.
  const total = state.clubsTotal || state.accounts || 0;
  const strip = $('rollcall');

  if (total === 0 || state.kind === 'story') {
    strip.innerHTML = '';
    return;
  }

  // Ticks are 1-indexed to match club:start/done/error events. The one in
  // flight is state.current; its position is the first not yet accounted for.
  let html = '';
  let currentMarked = false;
  for (let i = 1; i <= total; i++) {
    let cls = state.rollcall[i] || '';
    if (!cls && !currentMarked && state.current && state.status === 'running') {
      cls = 'current';
      currentMarked = true;
    }
    html += `<i class="${cls}"></i>`;
  }
  strip.innerHTML = html;
  strip.style.setProperty('--n', total);
  strip.setAttribute('aria-label', `${state.clubsDone} of ${total} accounts processed`);
}

function renderRun() {
  const done = state.clubsDone;
  const total = state.clubsTotal || state.accounts || 0;
  const running = state.status === 'running';

  $('run-status').textContent = state.status;
  $('run-status').className = `status ${state.status}`;
  $('start-run').disabled = running;
  $('cancel-run').hidden = !running;

  $('progress-label').textContent = running
    ? `${state.phase || 'starting'}${state.current ? ` · @${state.current}` : ''}`
    : (state.status === 'idle' ? 'No run yet' : `Finished in ${Math.round((state.durationMs || 0) / 1000)}s`);

  renderRollcall();

  $('stat-clubs').textContent = `${done}/${total}`;
  $('stat-posts').textContent = state.postsFound;
  $('stat-events').textContent = state.eventsExtracted;
  $('stat-errors').textContent = state.errors.length;

  const cost = estimateCost(state.usage);
  $('stat-cost').innerHTML = cost.calls
    ? `${usd(cost.usd)}<small>${plural(cost.calls, 'call')}</small>`
    : '—';

  $('error-list').innerHTML = state.errors
    .map(e => `<li><strong>@${escape(e.account)}</strong> — ${escape(e.message)}</li>`).join('');

  const card = $('summary-card');
  if (state.status === 'idle' || running) {
    card.hidden = true;
  } else {
    card.hidden = false;
    const sheet = state.sheet
      ? `${state.sheet.appended} added, ${state.sheet.updated} updated, ${state.sheet.skipped} unchanged`
      : 'nothing written';

    card.innerHTML = `
      <strong>Run ${escape(state.status)}</strong>
      <p>${plural(state.eventsExtracted, 'event')} from ${plural(state.postsFound, 'post')} across ${plural(done, 'account')}.</p>
      <p>Sheet: ${escape(sheet)}</p>
      ${cost.calls ? `<p>Claude: ${plural(cost.calls, 'call')}, about ${usd(cost.usd)} at list price.</p>` : ''}
      ${state.stderr ? `<pre>${escape(state.stderr)}</pre>` : ''}`;
  }

  $('log').textContent = state.log.map(l => l.message).join('\n');
  $('log').scrollTop = $('log').scrollHeight;
}

function subscribe(runId) {
  if (source) source.close();

  source = new EventSource(`/api/runs/${runId}/stream`);
  source.onmessage = (message) => {
    state = reduce(state, JSON.parse(message.data));
    renderRun();
    if (state.kind === 'story') renderStory();

    if (['ok', 'failed', 'cancelled'].includes(state.status)) {
      source.close();
      source = null;
      if (state.kind === 'story') loadStory();
    }
  };
}

$('start-run').addEventListener('click', async () => {
  try {
    const { runId } = await api('/api/runs', { method: 'POST' });
    state = initialState();
    subscribe(runId);
    renderRun();
  } catch (error) {
    $('run-status').textContent = error.message;
    $('run-status').className = 'status failed';
  }
});

$('cancel-run').addEventListener('click', () => {
  if (state.runId) api(`/api/runs/${state.runId}/cancel`, { method: 'POST' }).catch(() => {});
});

// ---- history tab

const fmtDay = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const fmtClock = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const fmtDuration = (ms) => {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

function describeRun(run) {
  if (run.kind === 'story') {
    if (!run.story) return run.status === 'ok' ? 'Generated' : '—';
    return run.story.pages === 0
      ? `${run.story.date} · no events that day`
      : `${run.story.date} · ${plural(run.story.pages, 'page')}`;
  }

  const s = run.summary;
  if (!s) return '—';
  return `${plural(s.clubsProcessed ?? 0, 'account')} · ${plural(s.totalPostsScraped ?? 0, 'post')} · ${plural(s.totalNewPostsAdded ?? 0, 'event')}`;
}

async function loadHistory() {
  const { runs } = await api('/api/history?limit=50');

  if (runs.length === 0) {
    $('history-table').innerHTML = '<tbody><tr><td class="empty">No runs yet. Start one from the Run tab.</td></tr></tbody>';
    return;
  }

  $('history-table').innerHTML = `
    <thead><tr>
      <th>Started</th><th>Kind</th><th>Status</th><th>Duration</th><th>Result</th><th>Claude, est.</th>
    </tr></thead>
    <tbody>${runs.map(run => {
      const cost = run.usage ? estimateCost(run.usage) : null;
      return `
      <tr data-run="${escape(run.id)}" tabindex="0">
        <td class="when">${run.startedAt ? `${fmtDay(run.startedAt)}<small>${fmtClock(run.startedAt)}</small>` : '—'}</td>
        <td><span class="pill kind-${escape(run.kind)}">${escape(run.kind)}</span></td>
        <td><span class="pill st-${escape(run.status)}">${escape(run.status)}</span></td>
        <td class="num">${fmtDuration(run.durationMs)}</td>
        <td class="result">${escape(describeRun(run))}</td>
        <td class="num">${cost && cost.calls ? usd(cost.usd) : '—'}</td>
      </tr>`;
    }).join('')}
    </tbody>`;

  for (const row of $('history-table').querySelectorAll('tr[data-run]')) {
    row.addEventListener('click', () => replayRun(row.dataset.run));
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); replayRun(row.dataset.run); } });
  }
}

async function replayRun(runId) {
  // Replaying into the Run tab reuses the whole live view rather than building a
  // second, subtly different renderer for finished runs.
  const { events } = await api(`/api/runs/${runId}`);
  state = reduceAll(initialState(), events);

  renderRun();
  document.querySelector('#tabs button[data-tab="run"]').click();
}

// ---- story tab

async function loadStory() {
  const date = $('story-date').value;
  if (!date) return;

  const { files } = await api(`/api/story/${date}`);
  paintStory(date, files);
}

function renderStory() {
  if (state.story) paintStory(state.story.date, state.story.files);

  $('story-status').textContent = state.status === 'running'
    ? (state.phase || 'starting')
    : (state.story?.pages === 0 ? 'No events on this date' : '');
  $('story-status').className = `status ${state.status === 'running' ? 'running' : ''}`;
}

function paintStory(date, files) {
  if (!files || files.length === 0) {
    $('story-pages').innerHTML = '<p class="status">Nothing rendered for this date yet. Generate it to see a preview here.</p>';
    return;
  }

  // Cache-bust so regenerating the same date visibly updates the preview.
  const stamp = Date.now();
  $('story-pages').innerHTML = files.map((file, i) => {
    const url = `/api/story/${date}/${encodeURIComponent(file)}`;
    return `
      <figure>
        <img src="${url}?v=${stamp}" alt="Story page ${i + 1} of ${files.length}">
        <figcaption>
          <span>Page ${i + 1} / ${files.length}</span>
          <a href="${url}" download="${escape(file)}">Download</a>
        </figcaption>
      </figure>`;
  }).join('');
}

$('story-date').addEventListener('change', loadStory);

$('generate-story').addEventListener('click', async () => {
  try {
    $('generate-story').disabled = true;
    const { runId } = await api('/api/story', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ date: $('story-date').value })
    });

    state = initialState();
    $('story-status').textContent = 'starting';
    $('story-status').className = 'status running';
    subscribe(runId);
  } catch (error) {
    $('story-status').textContent = error.message;
    $('story-status').className = 'status failed';
  } finally {
    $('generate-story').disabled = false;
  }
});

// ---- settings tab

const NUMERIC_FIELDS = [
  ['START_DAYS_AGO', 'Days to look back'],
  ['MAX_CLUBS_TO_PROCESS', 'Max accounts per run'],
  ['MAX_CAROUSEL_IMAGES', 'Carousel images sent to Claude'],
  ['APIFY_RESULTS_LIMIT', 'Posts fetched per account'],
  ['APIFY_MAX_CHARGE_USD', 'Apify cost ceiling per run (USD)']
];

async function loadSettings() {
  settings = await api('/api/settings');
  paintSettings();
  loadUsage();
}

function paintSettings() {
  const categories = Object.entries(settings.accounts.categories).map(([name, category]) => `
    <div class="category">
      <div class="category-head">
        <label>
          <input type="checkbox" data-category="${escape(name)}" ${category.enabled === false ? '' : 'checked'}>
          ${escape(name)}
        </label>
        <span class="count">${plural(category.accounts.length, 'account')}</span>
      </div>
      <div class="handles">${category.accounts.map(handle => `
        <span class="handle">@${escape(handle)}
          <button data-remove="${escape(handle)}" data-from="${escape(name)}" title="Remove @${escape(handle)}" aria-label="Remove @${escape(handle)}">×</button>
        </span>`).join('')}</div>
      <input type="text" class="add-handle" placeholder="add a handle, press Enter" data-add="${escape(name)}" aria-label="Add handle to ${escape(name)}">
    </div>`).join('');

  const secrets = Object.entries(settings.secrets)
    .map(([key, value]) => `<li><span>${escape(key)}</span><span class="status ${value === 'set' ? 'ok' : 'failed'}">${value}</span></li>`)
    .join('');

  $('settings-form').innerHTML = `
    <div class="settings-grid">
      <section class="panel">
        <h3>Accounts</h3>
        ${categories}
      </section>

      <section class="panel">
        <h3>Run settings</h3>
        ${NUMERIC_FIELDS.map(([key, label]) => `
          <div class="field numeric">
            <label for="env-${key}">${label}</label>
            <input type="text" id="env-${key}" data-env="${key}" value="${escape(settings.env[key] ?? '')}" inputmode="decimal">
          </div>`).join('')}
        <div class="save-row" style="margin-top:18px">
          <button id="save-settings" class="primary">Save changes</button>
        </div>
      </section>

      <section class="panel" id="usage-panel">
        <div class="usage-head">
          <h3>Usage</h3>
          <button class="link-button" id="refresh-usage">Refresh</button>
        </div>
        <div id="usage-body"><p class="note">Loading…</p></div>
      </section>

      <section class="panel">
        <h3>Secrets</h3>
        <p class="hint">Edited in <code>.env</code> only. The dashboard reports whether each is set and never reads the value.</p>
        <ul class="secrets">${secrets}</ul>
      </section>
    </div>`;

  $('save-settings').addEventListener('click', saveSettings);
  $('refresh-usage').addEventListener('click', loadUsage);

  for (const button of $('settings-form').querySelectorAll('[data-remove]')) {
    button.addEventListener('click', () => {
      const category = settings.accounts.categories[button.dataset.from];
      category.accounts = category.accounts.filter(h => h !== button.dataset.remove);
      paintSettings();
      loadUsage();
    });
  }

  for (const input of $('settings-form').querySelectorAll('[data-add]')) {
    input.addEventListener('keydown', (keyEvent) => {
      if (keyEvent.key !== 'Enter') return;

      const handle = input.value.trim().replace(/^@/, '');
      if (!handle) return;

      settings.accounts.categories[input.dataset.add].accounts.push(handle);
      paintSettings();
      loadUsage();
    });
  }

  for (const box of $('settings-form').querySelectorAll('[data-category]')) {
    box.addEventListener('change', () => {
      settings.accounts.categories[box.dataset.category].enabled = box.checked;
    });
  }
}

let usageCache = null;

async function loadUsage() {
  const body = $('usage-body');
  if (!body) return;
  if (usageCache) paintUsage(usageCache);

  try {
    usageCache = await api('/api/usage');
    paintUsage(usageCache);
  } catch (error) {
    body.innerHTML = `<p class="note">Usage unavailable: ${escape(error.message)}</p>`;
  }
}

function meter(used, limit) {
  if (limit == null || limit <= 0) return '';
  const pct = Math.min(100, (used / limit) * 100);
  const cls = pct >= 100 ? 'over' : pct >= 80 ? 'warn' : '';
  return `<div class="meter"><div class="meter-track"><div class="meter-fill ${cls}" style="width:${pct.toFixed(1)}%"></div></div></div>`;
}

function paintUsage({ claude, apify }) {
  const monthName = new Date(claude.since).toLocaleDateString(undefined, { month: 'long' });

  const apifyBlock = apify.ok ? `
    <div class="meter-row">
      <span class="big">${usd(apify.usedUsd)}</span>
      <span class="of">${apify.limitUsd != null ? `of ${usd(apify.limitUsd)} this cycle` : 'this cycle'}</span>
    </div>
    ${meter(apify.usedUsd, apify.limitUsd)}
    <p class="note">${apify.cycleEnd ? `Cycle resets ${fmtDay(Date.parse(apify.cycleEnd))}. ` : ''}Live from Apify.</p>`
    : `<p class="note">${escape(apify.reason || 'Unavailable')}.</p>`;

  const models = Object.entries(claude.sinceCutoff.byModel)
    .sort((a, b) => (b[1].usd ?? 0) - (a[1].usd ?? 0))
    .map(([model, u]) => `<li><span>${escape(model)}</span><span>${plural(u.calls, 'call')} · ${kilo(u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens)} in / ${kilo(u.outputTokens)} out · ${u.usd == null ? 'unpriced' : usd(u.usd)}</span></li>`)
    .join('');

  const claudeBlock = `
    <div class="meter-row">
      <span class="big">${usd(claude.sinceCutoff.usd)}</span>
      <span class="of">in ${escape(monthName)} · ${usd(claude.allTime.usd)} all time · ${plural(claude.allTime.runs, 'run')}</span>
    </div>
    ${models ? `<ul class="usage-detail">${models}</ul>` : `<p class="note">No Claude calls recorded yet this month.</p>`}
    <p class="note">Estimated from token counts at list price, for runs started from this dashboard. Your prepaid balance is only shown in the <a href="https://platform.claude.com/settings/billing" target="_blank" rel="noopener">Anthropic Console</a>.</p>`;

  $('usage-body').innerHTML = `
    <div class="settings-grid" style="gap:22px">
      <div><h3 style="margin-bottom:10px">Apify · month to date</h3>${apifyBlock}</div>
      <div><h3 style="margin-bottom:10px">Claude · estimated spend</h3>${claudeBlock}</div>
    </div>`;
}

async function saveSettings() {
  const env = {};
  for (const input of $('settings-form').querySelectorAll('[data-env]')) {
    if (input.value.trim() !== '') env[input.dataset.env] = input.value.trim();
  }

  try {
    settings = await api('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accounts: settings.accounts, env })
    });

    $('settings-status').textContent = 'Saved.';
    $('settings-status').className = 'status ok';
    paintSettings();
    loadUsage();
  } catch (error) {
    // The server validates before writing anything, so a rejected save left both
    // files untouched. Say so rather than leaving the user guessing.
    $('settings-status').textContent = `${error.message} — nothing was saved.`;
    $('settings-status').className = 'status failed';
  }
}

// ---- boot: reattach to a run already in flight

async function boot() {
  const info = await api('/api/state');
  state = { ...initialState(), accounts: info.accounts };

  if (info.active) {
    const snapshot = await api(`/api/runs/${info.active.runId}`);
    state = reduceAll(state, snapshot.events);
    subscribe(info.active.runId);
  }

  renderRun();
  $('story-date').value = new Date().toLocaleDateString('en-CA');
  loadStory();
}

boot();
