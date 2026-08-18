import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createEventHub } from '../web/events.js';
import { createRunner } from '../web/runner.js';
import { readRuns } from '../web/history.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

let dataDir;
let hub;
let runner;

const types = (runId) => hub.getBuffer(runId).map(e => e.t);

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-runner-'));
  hub = createEventHub();
  runner = createRunner({ projectDir: fixtures, dataDir, hub });
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('createRunner', () => {
  it('streams events from a healthy child and records success', async () => {
    const { runId } = runner.start({ kind: 'scrape', script: 'child-ok.js' });
    const end = await runner.waitForExit(runId);

    const seen = types(runId);

    // stdout and fd 3 are separate pipes, so a log line can interleave anywhere.
    // Assert the ordering that is actually guaranteed rather than a fixed list.
    expect(seen[0]).toBe('run:start');
    expect(seen.at(-1)).toBe('run:end');
    expect(seen).toContain('log');
    expect(seen.filter(t => !['run:start', 'run:end', 'log'].includes(t)))
      .toEqual(['run:config', 'club:start', 'club:done', 'summary']);

    expect(end).toMatchObject({ status: 'ok', exitCode: 0 });
    expect(end.durationMs).toBeGreaterThanOrEqual(0);

    const [record] = readRuns(dataDir);
    expect(record).toMatchObject({ id: runId, kind: 'scrape', status: 'ok' });
  });

  it('reassembles an event split across writes', async () => {
    const { runId } = runner.start({ kind: 'scrape', script: 'child-split-lines.js' });
    await runner.waitForExit(runId);

    const clubStart = hub.getBuffer(runId).find(e => e.t === 'club:start');
    expect(clubStart).toMatchObject({ index: 1, total: 1, account: 'msjbio' });
  });

  it('skips malformed lines and keeps the run going', async () => {
    const { runId } = runner.start({ kind: 'scrape', script: 'child-garbage.js' });
    const end = await runner.waitForExit(runId);

    const phases = hub.getBuffer(runId).filter(e => e.t === 'phase').map(e => e.name);
    expect(phases).toEqual(['prefetch', 'process']);
    expect(end.status).toBe('ok');
    expect(end.malformedLines).toBe(2);
  });

  it('records a nonzero exit as failed and keeps the stderr tail', async () => {
    const { runId } = runner.start({ kind: 'scrape', script: 'child-crash.js' });
    const end = await runner.waitForExit(runId);

    expect(end).toMatchObject({ status: 'failed', exitCode: 1 });
    expect(end.stderr).toContain('out of credit');
    expect(readRuns(dataDir)[0].status).toBe('failed');
  });

  it('refuses a second run while one is active', async () => {
    const { runId } = runner.start({ kind: 'scrape', script: 'child-hang.js' });

    // Two concurrent runs would both spend Apify credits and race to write the
    // same sheet rows, so this is refused rather than queued.
    let thrown = null;
    try {
      runner.start({ kind: 'scrape', script: 'child-ok.js' });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).not.toBeNull();
    expect(thrown.code).toBe('RUN_IN_PROGRESS');
    expect(thrown.runId).toBe(runId);

    runner.cancel(runId);
    await runner.waitForExit(runId);
  });

  it('releases the lock once a run finishes', async () => {
    const first = runner.start({ kind: 'scrape', script: 'child-ok.js' });
    await runner.waitForExit(first.runId);

    expect(runner.getActive()).toBeNull();

    const second = runner.start({ kind: 'scrape', script: 'child-ok.js' });
    await runner.waitForExit(second.runId);
    expect(runner.getActive()).toBeNull();
  });

  it('releases the lock even when the child crashes', async () => {
    const { runId } = runner.start({ kind: 'scrape', script: 'child-crash.js' });
    await runner.waitForExit(runId);

    expect(runner.getActive()).toBeNull();
  });

  it('reports a run that could not be spawned at all', async () => {
    const { runId } = runner.start({ kind: 'scrape', script: 'does-not-exist.js' });
    const end = await runner.waitForExit(runId);

    expect(end.status).toBe('failed');
    expect(runner.getActive()).toBeNull();
  });

  it('cancels a hung run', async () => {
    const { runId } = runner.start({ kind: 'scrape', script: 'child-hang.js' });

    expect(runner.cancel(runId)).toBe(true);
    const end = await runner.waitForExit(runId);

    expect(end.status).toBe('cancelled');
    expect(runner.getActive()).toBeNull();
  });

  it('ignores a cancel for a run that is not active', () => {
    expect(runner.cancel('run-nope')).toBe(false);
  });

  it('passes arguments through to the child', async () => {
    const seen = [];
    const fakeSpawn = (command, args) => {
      seen.push(args);
      return {
        stdout: { on() {} },
        stderr: { on() {} },
        stdio: [null, null, null, { on() {} }],
        kill() {},
        on(event, handler) { if (event === 'close') setImmediate(() => handler(0, null)); }
      };
    };

    const isolated = createRunner({ projectDir: fixtures, dataDir, hub, spawnFn: fakeSpawn });
    const { runId } = isolated.start({ kind: 'story', script: 'story.js', args: ['--date=2026-08-12'] });
    await isolated.waitForExit(runId);

    expect(seen[0].at(-1)).toBe('--date=2026-08-12');
  });

  it('persists events so a finished run can be replayed', async () => {
    const { runId } = runner.start({ kind: 'scrape', script: 'child-ok.js' });
    await runner.waitForExit(runId);

    const lines = fs.readFileSync(path.join(dataDir, 'runs', `${runId}.jsonl`), 'utf-8')
      .trim().split('\n').map(line => JSON.parse(line));

    expect(lines.map(e => e.t)).toContain('club:done');
    expect(lines.every(e => typeof e.seq === 'number')).toBe(true);
  });
});

describe('history record folding', () => {
  it('keeps the summary, story result, and Claude usage on the run record', async () => {
    const { runId } = runner.start({ kind: 'scrape', script: 'child-usage.js' });
    await runner.waitForExit(runId);

    const [record] = readRuns(dataDir);
    expect(record.summary).toEqual({ clubsProcessed: 2, totalPostsScraped: 5, totalNewPostsAdded: 3 });
    expect(record.story).toEqual({ date: '2026-08-17', pages: 2 });
    expect(record.usage).toEqual({
      'claude-haiku-4-5': { calls: 2, inputTokens: 150, outputTokens: 15, cacheReadTokens: 7, cacheWriteTokens: 0 },
      'claude-sonnet-5':  { calls: 1, inputTokens: 900, outputTokens: 90, cacheReadTokens: 0, cacheWriteTokens: 0 }
    });
  });

  it('leaves those fields absent for a run that never reported them', async () => {
    const { runId } = runner.start({ kind: 'scrape', script: 'child-crash.js' });
    await runner.waitForExit(runId);

    const [record] = readRuns(dataDir);
    expect(record.summary).toBeUndefined();
    expect(record.story).toBeUndefined();
    expect(record.usage).toBeUndefined();
  });
});
