import { initialState, reduce, reduceAll } from './state.js';

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

// ---- tabs

for (const button of document.querySelectorAll('#tabs button')) {
  button.addEventListener('click', () => {
    for (const other of document.querySelectorAll('#tabs button')) other.classList.remove('active');
    for (const tab of document.querySelectorAll('.tab')) tab.classList.remove('active');

    button.classList.add('active');
    $(`tab-${button.dataset.tab}`).classList.add('active');

    if (button.dataset.tab === 'history') loadHistory();
    if (button.dataset.tab === 'settings') loadSettings();
  });
}

// ---- run tab

function renderRun() {
  const done = state.clubsDone;
  const total = state.clubsTotal || state.accounts || 0;
  const running = state.status === 'running';

  $('run-status').textContent = state.status;
  $('run-status').className = `status ${state.status}`;
  $('start-run').disabled = running;
  $('cancel-run').hidden = !running;

  $('progress').style.width = total ? `${Math.round((done / total) * 100)}%` : '0';
  $('progress-label').textContent = running
    ? `${state.phase || 'starting'}${state.current ? ` · @${state.current}` : ''}`
    : (state.status === 'idle' ? 'No run yet' : `Finished in ${Math.round((state.durationMs || 0) / 1000)}s`);

  $('stat-clubs').textContent = `${done}/${total}`;
  $('stat-posts').textContent = state.postsFound;
  $('stat-events').textContent = state.eventsExtracted;
  $('stat-errors').textContent = state.errors.length;

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
      <p>${state.eventsExtracted} event(s) from ${state.postsFound} post(s) across ${done} account(s).</p>
      <p>Sheet: ${escape(sheet)}</p>
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

const fmtTime = (ms) => ms ? new Date(ms).toLocaleString() : '—';
const fmtDuration = (ms) => ms ? `${Math.round(ms / 1000)}s` : '—';

async function loadHistory() {
  const { runs } = await api('/api/history?limit=50');

  if (runs.length === 0) {
    $('history-table').innerHTML = '<tbody><tr><td>No runs yet.</td></tr></tbody>';
    return;
  }

  $('history-table').innerHTML = `
    <thead><tr>
      <th>Started</th><th>Kind</th><th>Status</th><th>Duration</th>
      <th>Clubs</th><th>Posts</th><th>Events</th>
    </tr></thead>
    <tbody>${runs.map(run => `
      <tr data-run="${escape(run.id)}">
        <td>${fmtTime(run.startedAt)}</td>
        <td>${escape(run.kind)}</td>
        <td class="status ${escape(run.status)}">${escape(run.status)}</td>
        <td>${fmtDuration(run.durationMs)}</td>
        <td>${run.summary?.clubsProcessed ?? '—'}</td>
        <td>${run.summary?.totalPostsScraped ?? '—'}</td>
        <td>${run.summary?.totalNewPostsAdded ?? '—'}</td>
      </tr>`).join('')}
    </tbody>`;

  for (const row of $('history-table').querySelectorAll('tr[data-run]')) {
    row.addEventListener('click', () => replayRun(row.dataset.run));
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
}

function paintStory(date, files) {
  if (!files || files.length === 0) {
    $('story-pages').innerHTML = '<p class="status">Nothing rendered for this date yet.</p>';
    return;
  }

  // Cache-bust so regenerating the same date visibly updates the preview.
  const stamp = Date.now();
  $('story-pages').innerHTML = files.map((file, i) => {
    const url = `/api/story/${date}/${encodeURIComponent(file)}`;
    return `
      <figure>
        <img src="${url}?v=${stamp}" alt="Story page ${i + 1}">
        <figcaption><a href="${url}" download="${escape(file)}">Download page ${i + 1}</a></figcaption>
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
    subscribe(runId);
  } catch (error) {
    $('story-status').textContent = error.message;
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
  ['APIFY_MAX_CHARGE_USD', 'Apify cost ceiling (USD)']
];

async function loadSettings() {
  settings = await api('/api/settings');
  paintSettings();
}

function paintSettings() {
  const categories = Object.entries(settings.accounts.categories).map(([name, category]) => `
    <div class="field">
      <label>
        <input type="checkbox" data-category="${escape(name)}" ${category.enabled === false ? '' : 'checked'}>
        ${escape(name)} — ${category.accounts.length} account(s)
      </label>
      <div>${category.accounts.map(handle => `
        <span class="handle">@${escape(handle)}
          <button data-remove="${escape(handle)}" data-from="${escape(name)}" title="Remove">×</button>
        </span>`).join('')}</div>
      <input type="text" placeholder="add handle + Enter" data-add="${escape(name)}">
    </div>`).join('');

  const secrets = Object.entries(settings.secrets)
    .map(([key, value]) => `<li>${escape(key)}: <span class="status ${value === 'set' ? 'ok' : 'failed'}">${value}</span></li>`)
    .join('');

  $('settings-form').innerHTML = `
    <h2>Accounts</h2>${categories}
    <h2>Run settings</h2>
    ${NUMERIC_FIELDS.map(([key, label]) => `
      <div class="field">
        <label for="env-${key}">${label}</label>
        <input type="text" id="env-${key}" data-env="${key}" value="${escape(settings.env[key] ?? '')}">
      </div>`).join('')}
    <button id="save-settings" class="primary">Save</button>
    <h2>Secrets</h2>
    <p class="status">Edited in .env only — the dashboard never reads their values.</p>
    <ul>${secrets}</ul>`;

  $('save-settings').addEventListener('click', saveSettings);

  for (const button of $('settings-form').querySelectorAll('[data-remove]')) {
    button.addEventListener('click', () => {
      const category = settings.accounts.categories[button.dataset.from];
      category.accounts = category.accounts.filter(h => h !== button.dataset.remove);
      paintSettings();
    });
  }

  for (const input of $('settings-form').querySelectorAll('[data-add]')) {
    input.addEventListener('keydown', (keyEvent) => {
      if (keyEvent.key !== 'Enter') return;

      const handle = input.value.trim().replace(/^@/, '');
      if (!handle) return;

      settings.accounts.categories[input.dataset.add].accounts.push(handle);
      paintSettings();
    });
  }

  for (const box of $('settings-form').querySelectorAll('[data-category]')) {
    box.addEventListener('change', () => {
      settings.accounts.categories[box.dataset.category].enabled = box.checked;
    });
  }
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
