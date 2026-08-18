import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { createEventHub } from '../web/events.js';
import { createServer } from '../web/server.js';

let dir, hub, server, base, fakeRunner, started, apifyCalls, apifyResponse;

const fixtureAccounts = {
  categories: { clubs: { enabled: true, accounts: ['msjbio'] } },
  settings: { defaultCategory: 'clubs' }
};

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-server-'));
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify(fixtureAccounts));
  fs.writeFileSync(path.join(dir, '.env'), 'START_DAYS_AGO=7\nAPIFY_TOKEN=topsecretvalue\n');

  hub = createEventHub();
  started = [];
  fakeRunner = {
    active: null,
    start(options) {
      if (this.active) {
        const error = new Error('busy');
        error.code = 'RUN_IN_PROGRESS';
        error.runId = this.active.runId;
        throw error;
      }
      started.push(options);
      this.active = { runId: 'run-1', kind: options.kind, startedAt: 1000 };
      return { runId: 'run-1' };
    },
    cancel(runId) {
      if (this.active?.runId === runId) { this.active = null; return true; }
      return false;
    },
    getActive() { return this.active; }
  };

  apifyCalls = [];
  apifyResponse = { ok: true, status: 200, json: async () => ({ data: {
    monthlyUsageCycle: { startAt: '2026-08-01T00:00:00.000Z', endAt: '2026-09-01T00:00:00.000Z' },
    limits: { maxMonthlyUsageUsd: 49 },
    current: { monthlyUsageUsd: 5.5 }
  } }) };
  const apifyFetch = async (url, options) => { apifyCalls.push({ url, options }); return apifyResponse; };

  server = createServer({ projectDir: dir, dataDir: dir, storyDir: dir, runner: fakeRunner, hub, apifyFetch });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the web server', () => {
  it('reports idle state with the true account count', async () => {
    const body = await (await fetch(`${base}/api/state`)).json();
    expect(body.active).toBeNull();
    expect(body.accounts).toBe(1);
    expect(body.lastRun).toBeNull();
  });

  it('starts a scrape run', async () => {
    const response = await fetch(`${base}/api/runs`, { method: 'POST' });

    expect(response.status).toBe(201);
    expect((await response.json()).runId).toBe('run-1');
    expect(started[0]).toMatchObject({ kind: 'scrape', script: 'main.js' });
  });

  it('refuses a concurrent run with 409 and names the active one', async () => {
    await fetch(`${base}/api/runs`, { method: 'POST' });
    const response = await fetch(`${base}/api/runs`, { method: 'POST' });

    expect(response.status).toBe(409);
    expect((await response.json()).activeRunId).toBe('run-1');
  });

  it('starts a story run for a given date', async () => {
    const response = await fetch(`${base}/api/story`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ date: '2026-08-12' })
    });

    expect(response.status).toBe(201);
    expect(started[0]).toMatchObject({ kind: 'story', script: 'story.js', args: ['--date=2026-08-12'] });
  });

  it('rejects a malformed story date instead of passing it through', async () => {
    const response = await fetch(`${base}/api/story`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ date: '2026-08-12; rm -rf /' })
    });

    expect(response.status).toBe(400);
    expect(started).toHaveLength(0);
  });

  it('returns a run snapshot built from the buffer', async () => {
    hub.publish('run-1', { t: 'run:config', accounts: 85 });
    hub.publish('run-1', { t: 'club:done', index: 1, total: 85, account: 'msjbio', postsFound: 2, eventsExtracted: 1 });

    const body = await (await fetch(`${base}/api/runs/run-1`)).json();
    expect(body.events).toHaveLength(2);
    expect(body.lastSeq).toBe(2);
  });

  it('replays a finished run from disk once it has left memory', async () => {
    fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'runs', 'run-old.jsonl'),
      '{"t":"run:start","seq":1}\n{"t":"run:end","ok":true,"seq":2}\n');

    const body = await (await fetch(`${base}/api/runs/run-old`)).json();
    expect(body.events.map(e => e.t)).toEqual(['run:start', 'run:end']);
    expect(body.lastSeq).toBe(2);
  });

  it('cancels a run', async () => {
    await fetch(`${base}/api/runs`, { method: 'POST' });
    const response = await fetch(`${base}/api/runs/run-1/cancel`, { method: 'POST' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cancelled: true });
    expect(fakeRunner.getActive()).toBeNull();
  });

  it('never exposes secret values through settings', async () => {
    const body = await (await fetch(`${base}/api/settings`)).json();

    expect(body.secrets.APIFY_TOKEN).toBe('set');
    expect(JSON.stringify(body)).not.toContain('topsecretvalue');
    expect(body.env.APIFY_TOKEN).toBeUndefined();
  });

  it('rejects a settings write outside the allowlist', async () => {
    const response = await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ env: { APIFY_TOKEN: 'stolen' } })
    });

    expect(response.status).toBe(400);
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf-8')).toContain('topsecretvalue');
  });

  it('lists rendered story pages for a date', async () => {
    fs.writeFileSync(path.join(dir, 'story-2026-08-12-p1.png'), 'png');
    fs.writeFileSync(path.join(dir, 'story-2026-08-12-p2.png'), 'png');
    fs.writeFileSync(path.join(dir, 'story-2026-08-11-p1.png'), 'png');

    const body = await (await fetch(`${base}/api/story/2026-08-12`)).json();
    expect(body.files).toEqual(['story-2026-08-12-p1.png', 'story-2026-08-12-p2.png']);
  });

  it('refuses to serve a file outside the story directory', async () => {
    const response = await fetch(`${base}/api/story/2026-08-12/..%2F..%2F.env`);
    expect(response.status).toBe(400);
  });

  it('rejects a request whose Host header points at another domain', async () => {
    // DNS rebinding: an attacker domain re-resolved to 127.0.0.1 would otherwise
    // be same-origin with the dashboard and able to read and write everything.
    // fetch() treats Host as a forbidden header and drops it, so this goes out
    // over a raw request.
    const status = await new Promise((resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1',
        port: server.address().port,
        path: '/api/settings',
        method: 'GET',
        headers: { host: 'evil.example.com' }
      }, response => {
        response.resume();
        resolve(response.statusCode);
      });
      request.on('error', reject);
      request.end();
    });

    expect(status).toBe(403);
  });

  it('rejects a cross-origin request that starts a run', async () => {
    // POST /api/runs takes no body and no custom headers, so it is a CORS
    // simple request: any page could fire it and spend Apify credit.
    const response = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { origin: 'https://evil.example.com' }
    });

    expect(response.status).toBe(403);
    expect(started).toHaveLength(0);
  });

  it('allows a request from the dashboard itself', async () => {
    const response = await fetch(`${base}/api/state`, { headers: { origin: base } });
    expect(response.status).toBe(200);
  });

  it('404s an unknown route', async () => {
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
  });

  it('rejects a body that is not JSON', async () => {
    const response = await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: 'not json'
    });
    expect(response.status).toBe(400);
  });
});

describe('GET /api/usage', () => {
  const day = 24 * 60 * 60 * 1000;
  const haiku = (inputTokens) => ({ 'claude-haiku-4-5': { calls: 1, inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } });

  it('estimates Claude spend from recorded runs, this month and all time', async () => {
    const now = Date.now();
    const monthStart = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1).getTime();
    const lines = [
      { id: 'old', kind: 'scrape', status: 'ok', startedAt: monthStart - 40 * day, usage: haiku(1_000_000) },
      { id: 'new', kind: 'scrape', status: 'ok', startedAt: monthStart + 1, usage: haiku(2_000_000) }
    ];
    fs.writeFileSync(path.join(dir, 'runs.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');

    const body = await (await fetch(`${base}/api/usage`)).json();

    expect(body.claude.allTime.usd).toBeCloseTo(3, 6);
    expect(body.claude.allTime.runs).toBe(2);
    expect(body.claude.sinceCutoff.usd).toBeCloseTo(2, 6);
    expect(body.claude.sinceCutoff.runs).toBe(1);
    expect(body.claude.since).toBe(monthStart);
  });

  it('reports Apify month-to-date spend using the token from .env, and caches it', async () => {
    const first = await (await fetch(`${base}/api/usage`)).json();
    const second = await (await fetch(`${base}/api/usage`)).json();

    expect(first.apify).toEqual({
      ok: true, usedUsd: 5.5, limitUsd: 49,
      cycleStart: '2026-08-01T00:00:00.000Z', cycleEnd: '2026-09-01T00:00:00.000Z'
    });
    expect(second.apify).toEqual(first.apify);
    expect(apifyCalls).toHaveLength(1);
    expect(apifyCalls[0].options.headers.Authorization).toBe('Bearer topsecretvalue');
  });

  it('still answers the Claude half when Apify is unavailable', async () => {
    apifyResponse = { ok: false, status: 503, json: async () => ({}) };

    const response = await fetch(`${base}/api/usage`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.apify.ok).toBe(false);
    expect(body.claude.allTime.runs).toBe(0);
  });

  it('never echoes the Apify token', async () => {
    const text = await (await fetch(`${base}/api/usage`)).text();
    expect(text).not.toContain('topsecretvalue');
  });
});

describe('brand fonts', () => {
  it('serves the story fonts so the dashboard matches the graphic', async () => {
    fs.mkdirSync(path.join(dir, 'assets', 'fonts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'assets', 'fonts', 'Satoshi-Variable.woff2'), 'woff2-bytes');

    const response = await fetch(`${base}/fonts/Satoshi-Variable.woff2`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('font/woff2');
    expect(await response.text()).toBe('woff2-bytes');
  });

  it('only serves woff2 files by plain name', async () => {
    fs.mkdirSync(path.join(dir, 'assets', 'fonts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'assets', 'fonts', 'Satoshi-Variable.woff2'), 'x');

    expect((await fetch(`${base}/fonts/..%2F..%2F.env`)).status).toBe(404);
    expect((await fetch(`${base}/fonts/missing.woff2`)).status).toBe(404);
    expect((await fetch(`${base}/fonts/Satoshi-Variable.ttf`)).status).toBe(404);
  });
});

describe('logo files', () => {
  it('serves the favicon and touch icon from assets/logo', async () => {
    fs.mkdirSync(path.join(dir, 'assets', 'logo'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'assets', 'logo', 'favicon.svg'), '<svg/>');
    fs.writeFileSync(path.join(dir, 'assets', 'logo', 'apple-touch-icon-180.png'), 'png-bytes');

    const svg = await fetch(`${base}/favicon.svg`);
    expect(svg.status).toBe(200);
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');
    expect(await svg.text()).toBe('<svg/>');

    const touch = await fetch(`${base}/apple-touch-icon.png`);
    expect(touch.status).toBe(200);
    expect(touch.headers.get('content-type')).toBe('image/png');
  });

  it('404s when the logo has not been rendered yet', async () => {
    expect((await fetch(`${base}/favicon.svg`)).status).toBe(404);
  });
});
