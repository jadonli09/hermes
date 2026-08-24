// Thirteen routes and a static directory do not need a framework, and not having
// one keeps package.json honest about what this actually depends on.
//
// Binds 127.0.0.1 only. There is no auth, and this process can spend money.
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { backfillRuns, readRuns, runEventsPath } from './history.js';
import { readSecret, readSettings, writeSettings } from './settings.js';
import { fetchApifyUsage } from './apify-usage.js';
import { summarizeRuns } from './usage.js';
import { listReviewEvents, applyReviewUpdate, validateReviewUpdate, markAsRecap, validateRowIndex } from './review.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const STORY_FILE = /^story-\d{4}-\d{2}-\d{2}-p\d+\.png$/;
const FONT_FILE = /^\/fonts\/([A-Za-z0-9-]+\.woff2)$/;
const MAX_BODY_BYTES = 1_000_000;
const APIFY_CACHE_MS = 60_000;   // Apify asks for gentle polling; the number moves slowly anyway

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml'
};

// Browser-conventional names, mapped onto the rendered set in assets/logo.
const LOGO_ROUTES = {
  '/favicon.svg': 'favicon.svg',
  '/apple-touch-icon.png': 'apple-touch-icon-180.png'
};

/**
 * Binding to 127.0.0.1 keeps other machines out, but it does not keep out a web
 * page the user happens to visit: their own browser originates the request, so
 * any site can POST here and start a run that spends real Apify credit.
 *
 * Two checks close that. Host pinning defeats DNS rebinding, where an attacker
 * domain is re-resolved to 127.0.0.1 and becomes same-origin with us. Origin
 * pinning defeats plain CSRF, including the "simple request" forms that browsers
 * send without a preflight.
 */
function isTrustedRequest(req) {
  const host = req.headers.host || '';
  const hostname = host.replace(/:\d+$/, '');
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') {
    return false;
  }

  // Same-origin requests from our own page send no Origin on GET, and our own
  // origin on writes. Anything else is another site talking to us.
  const origin = req.headers.origin;
  if (!origin) return true;

  try {
    const originHost = new URL(origin).host.replace(/:\d+$/, '');
    return originHost === '127.0.0.1' || originHost === 'localhost' || originHost === '[::1]';
  } catch {
    return false;
  }
}

function sendJson(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text)
  });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body too large');
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch {
    throw new Error('Body must be valid JSON');
  }
}

function countAccounts(projectDir) {
  const { accounts } = readSettings(projectDir);
  return Object.values(accounts.categories)
    .filter(category => category.enabled !== false)
    .reduce((total, category) => total + (category.accounts?.length || 0), 0);
}

function startRun(res, runner, options) {
  try {
    return sendJson(res, 201, runner.start(options));
  } catch (error) {
    if (error.code === 'RUN_IN_PROGRESS') {
      return sendJson(res, 409, { error: error.message, activeRunId: error.runId });
    }
    throw error;
  }
}

export function createServer({ projectDir, dataDir, storyDir, runner, hub, apifyFetch = globalThis.fetch, sheetsClient = null }) {
  let apifyCache = null;   // { at, value }
  let sheetsPromise = null;

  // Lazy and injectable: tests pass a fake, and a dashboard used only for runs
  // never authenticates against Google at all.
  function getSheets() {
    if (sheetsClient) return Promise.resolve(sheetsClient);
    if (!sheetsPromise) {
      sheetsPromise = (async () => {
        const [{ authenticateSheets }, { getCredentialsPath }] = await Promise.all([
          import('../sheets-writer.js'),
          import('../config-manager.js')
        ]);
        return authenticateSheets(getCredentialsPath(projectDir));
      })().catch(error => {
        sheetsPromise = null;   // a failed auth is retried on the next request
        throw error;
      });
    }
    return sheetsPromise;
  }

  function spreadsheetId() {
    const id = readSecret(projectDir, 'GOOGLE_SPREADSHEET_ID');
    if (!id) throw new Error('GOOGLE_SPREADSHEET_ID is not set in .env');
    return id;
  }

  async function apifyUsage() {
    if (apifyCache && Date.now() - apifyCache.at < APIFY_CACHE_MS) return apifyCache.value;
    const value = await fetchApifyUsage({ token: readSecret(projectDir, 'APIFY_TOKEN'), fetch: apifyFetch });
    if (value.ok) apifyCache = { at: Date.now(), value };   // a failure is retried on the next request
    return value;
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = `${req.method} ${url.pathname}`;

    if (!isTrustedRequest(req)) {
      return sendJson(res, 403, { error: 'Request did not originate from the local dashboard' });
    }

    try {
      if (route === 'GET /api/state') {
        const active = runner.getActive();
        return sendJson(res, 200, {
          active,
          accounts: countAccounts(projectDir),
          lastRun: readRuns(dataDir, { limit: 1, activeRunId: active?.runId })[0] || null
        });
      }

      if (route === 'POST /api/runs') {
        return startRun(res, runner, { kind: 'scrape', script: 'main.js' });
      }

      if (route === 'POST /api/story') {
        const { date } = await readBody(req);
        if (date !== undefined && date !== null && !ISO_DATE.test(String(date))) {
          return sendJson(res, 400, { error: 'date must be YYYY-MM-DD' });
        }

        return startRun(res, runner, {
          kind: 'story',
          script: 'story.js',
          args: date ? [`--date=${date}`] : []
        });
      }

      if (route === 'GET /api/history') {
        const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 500);
        return sendJson(res, 200, {
          runs: backfillRuns(dataDir, readRuns(dataDir, { limit, activeRunId: runner.getActive()?.runId }))
        });
      }

      const runMatch = url.pathname.match(/^\/api\/runs\/([A-Za-z0-9_-]+)(\/stream|\/cancel)?$/);
      if (runMatch) {
        const [, runId, suffix] = runMatch;

        if (req.method === 'GET' && !suffix) {
          const buffered = hub.getBuffer(runId);
          if (buffered.length > 0) {
            return sendJson(res, 200, { events: buffered, lastSeq: buffered.at(-1).seq || 0 });
          }

          // A finished run has aged out of memory; replay it from disk.
          const file = runEventsPath(dataDir, runId);
          if (!fs.existsSync(file)) return sendJson(res, 200, { events: [], lastSeq: 0 });

          const replayed = fs.readFileSync(file, 'utf-8')
            .split('\n').filter(Boolean)
            .map(line => { try { return JSON.parse(line); } catch { return null; } })
            .filter(Boolean);

          return sendJson(res, 200, { events: replayed, lastSeq: replayed.at(-1)?.seq || 0 });
        }

        if (req.method === 'GET' && suffix === '/stream') {
          hub.subscribe(runId, res, { lastEventId: req.headers['last-event-id'] });
          return;
        }

        if (req.method === 'POST' && suffix === '/cancel') {
          return sendJson(res, 200, { cancelled: runner.cancel(runId) });
        }
      }

      if (route === 'GET /api/usage') {
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
        const runs = backfillRuns(dataDir, readRuns(dataDir, { limit: 100_000, activeRunId: runner.getActive()?.runId }));
        return sendJson(res, 200, {
          claude: summarizeRuns(runs, { since: monthStart }),
          apify: await apifyUsage()
        });
      }

      if (route === 'GET /api/review') {
        // Local date, matching story.js: "today" is the school's today
        const today = new Date().toLocaleDateString('en-CA');
        const events = await listReviewEvents(await getSheets(), spreadsheetId(), today);
        return sendJson(res, 200, { events });
      }

      if (route === 'PUT /api/review') {
        const { rowIndex, fields } = await readBody(req);

        // Bad input is the caller's fault (400); a Sheets failure after
        // validation falls through to the generic 500 below.
        try {
          validateReviewUpdate(rowIndex, fields);
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }

        const result = await applyReviewUpdate(await getSheets(), spreadsheetId(), rowIndex, fields);
        return sendJson(res, 200, result);
      }

      if (route === 'POST /api/review/recap') {
        const { rowIndex } = await readBody(req);

        try {
          validateRowIndex(rowIndex);
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }

        return sendJson(res, 200, await markAsRecap(await getSheets(), spreadsheetId(), rowIndex));
      }

      if (route === 'GET /api/settings') {
        return sendJson(res, 200, readSettings(projectDir));
      }

      if (route === 'PUT /api/settings') {
        try {
          return sendJson(res, 200, writeSettings(projectDir, await readBody(req)));
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }

      const storyList = url.pathname.match(/^\/api\/story\/(\d{4}-\d{2}-\d{2})$/);
      if (req.method === 'GET' && storyList) {
        const files = fs.existsSync(storyDir)
          ? fs.readdirSync(storyDir).filter(name => name.startsWith(`story-${storyList[1]}-p`)).sort()
          : [];
        return sendJson(res, 200, { date: storyList[1], files });
      }

      const storyFile = url.pathname.match(/^\/api\/story\/(\d{4}-\d{2}-\d{2})\/(.+)$/);
      if (req.method === 'GET' && storyFile) {
        // Match against the exact name the story generator writes rather than
        // trying to sanitize an arbitrary path.
        const name = decodeURIComponent(storyFile[2]);
        if (!STORY_FILE.test(name)) {
          return sendJson(res, 400, { error: 'Not a story image name' });
        }

        const file = path.join(storyDir, name);
        if (!fs.existsSync(file)) return sendJson(res, 404, { error: 'Not found' });

        res.writeHead(200, { 'Content-Type': 'image/png' });
        return fs.createReadStream(file).pipe(res);
      }

      if (req.method === 'GET' && LOGO_ROUTES[url.pathname]) {
        const file = path.join(projectDir, 'assets', 'logo', LOGO_ROUTES[url.pathname]);
        if (!fs.existsSync(file)) return sendJson(res, 404, { error: 'Not found' });
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)], 'Cache-Control': 'public, max-age=86400' });
        return fs.createReadStream(file).pipe(res);
      }

      // The dashboard is set in the same faces as the story graphic, which live
      // in assets/fonts rather than under web/public.
      const font = url.pathname.match(FONT_FILE);
      if (req.method === 'GET' && font) {
        const file = path.join(projectDir, 'assets', 'fonts', font[1]);
        if (!fs.existsSync(file)) return sendJson(res, 404, { error: 'Not found' });
        res.writeHead(200, { 'Content-Type': MIME['.woff2'], 'Cache-Control': 'public, max-age=86400' });
        return fs.createReadStream(file).pipe(res);
      }

      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const file = path.join(PUBLIC_DIR, name);

        if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file)) {
          return sendJson(res, 404, { error: 'Not found' });
        }

        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        return fs.createReadStream(file).pipe(res);
      }

      return sendJson(res, 404, { error: 'Not found' });

    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { error: error.message });
    }
  });
}

export function startServer({ port = 4317, host = '127.0.0.1', ...options }) {
  const server = createServer(options);

  return new Promise((resolve, reject) => {
    server.once('error', (error) => {
      reject(error.code === 'EADDRINUSE'
        ? new Error(`Port ${port} is already in use. Set PORT to something else.`)
        : error);
    });
    server.listen(port, host, () => resolve(server));
  });
}
