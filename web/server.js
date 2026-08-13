// Eleven routes and a static directory do not need a framework, and not having
// one keeps package.json honest about what this actually depends on.
//
// Binds 127.0.0.1 only. There is no auth, and this process can spend money.
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { readRuns, runEventsPath } from './history.js';
import { readSettings, writeSettings } from './settings.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const STORY_FILE = /^story-\d{4}-\d{2}-\d{2}-p\d+\.png$/;
const MAX_BODY_BYTES = 1_000_000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8'
};

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

export function createServer({ projectDir, dataDir, storyDir, runner, hub }) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = `${req.method} ${url.pathname}`;

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
          runs: readRuns(dataDir, { limit, activeRunId: runner.getActive()?.runId })
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
