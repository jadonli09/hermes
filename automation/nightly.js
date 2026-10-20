import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digest, readState, writeState, lock } from './state.js';
import { refreshScope } from './refresh-activity.js';
import { latestPipelineActivity, recordPipelineActivity, healthyPipeline } from './pipeline-activity.js';
import { advanceAccounts, qualifyOutstandingGaps } from './coverage.js';
import { sendEmail, validateEmailConfig } from './email.js';

export const ZONE = 'America/Los_Angeles';
const DAY = 86400000;
export function localParts(now) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]));
}
export function addDays(date, count) { return new Date(Date.parse(`${date}T12:00:00Z`) + count * DAY).toISOString().slice(0, 10); }
export function pacificInstant(date, hour = 0) {
  const wanted = Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00Z`);
  let instant = wanted;
  for (let i = 0; i < 3; i++) {
    const p = localParts(new Date(instant));
    const wall = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:00:00Z`);
    instant += wanted - wall;
  }
  return new Date(instant).toISOString();
}
export function slotFor(now = new Date()) {
  const p = localParts(now), today = `${p.year}-${p.month}-${p.day}`, hour = Number(p.hour);
  // Wake-up catch-up until 06:00 the next morning. Never send yesterday's story.
  const night = hour >= 21 ? today : hour < 6 ? addDays(today, -1) : null;
  if (!night || [5, 6].includes(new Date(`${night}T12:00:00Z`).getUTCDay())) return null;
  return { night, targetDate: addDays(night, 1), scheduledAt: pacificInstant(night, 21), cutoff: pacificInstant(addDays(night, 1), 6) };
}
// Every night re-scans an overlapping window so a post missed once (blocked
// profile, late visibility, several posts in a day) gets more chances. Posts
// already in the Sheet are skipped before extraction, so overlap costs only
// Apify rows, not Claude calls.
export const LOOKBACK_DAYS = 4, MAX_LOOKBACK_DAYS = 11, MIN_RESULTS_LIMIT = 8;
export function fetchPlan(slot, checkpoint, scope) {
  const last = checkpoint?.scope === scope ? checkpoint : null;
  const dayOf = instant => { const p = localParts(new Date(instant)); return `${p.year}-${p.month}-${p.day}`; };
  const dayGap = date => Math.round((Date.parse(`${slot.night}T12:00:00Z`) - Date.parse(`${date}T12:00:00Z`)) / DAY);
  if (last && (!Number.isFinite(Date.parse(last.coveredFrom)) || Date.parse(last.coveredFrom) >= Date.parse(slot.cutoff))) throw new Error('Invalid refresh checkpoint');
  const rolling = pacificInstant(addDays(slot.night, -(LOOKBACK_DAYS - 1)));
  const floor = pacificInstant(addDays(slot.night, -(MAX_LOOKBACK_DAYS - 1)));
  // Widen back to the last source-healthy run, never past the floor.
  let since = !last ? floor : new Date(Math.max(Date.parse(floor), Math.min(Date.parse(rolling), Date.parse(last.coveredFrom)))).toISOString();
  // A manual refresh can finish during the same night's catch-up window.
  // Reuse the scheduled boundary conservatively rather than rejecting activity.
  if (Date.parse(since) >= Date.parse(slot.scheduledAt)) since = new Date(Date.parse(slot.scheduledAt) - 1).toISOString();
  const limit = Math.max(MIN_RESULTS_LIMIT, 2 * (dayGap(dayOf(since)) + 1));
  const reason = !last ? 'no-trusted-history'
    : since === floor && Date.parse(last.coveredFrom) < Date.parse(floor) ? 'max-lookback'
    : Date.parse(since) < Date.parse(rolling) ? 'extended-after-gap' : 'rolling';
  return { since, limit, catchUp: reason !== 'rolling', reason, budgetUsd: 2 };
}

export function runChild(script, args, { projectDir, env, logFile, timeoutMs = 35 * 60 * 1000 }) {
  return new Promise((resolve, reject) => {
    const fd = fs.openSync(logFile, 'a', 0o600);
    const child = spawn(process.execPath, [path.join(projectDir, script), ...args], { cwd: projectDir, env: { ...process.env, ...env, HERMES_PROGRESS: 'json', TZ: ZONE }, stdio: ['ignore', fd, fd, 'pipe'] });
    let tail = '', events = [], expired = false;
    child.stdio[3].on('data', data => {
      tail += data.toString(); let newline;
      while ((newline = tail.indexOf('\n')) !== -1) {
        const line = tail.slice(0, newline); tail = tail.slice(newline + 1);
        try { const e = JSON.parse(line); if (['summary', 'story:done', 'coverage'].includes(e.t)) events.push(e); } catch { /* missing final manifest is fatal below */ }
      }
    });
    const timer = setTimeout(() => { expired = true; child.kill('SIGTERM'); }, timeoutMs);
    const killer = setTimeout(() => child.kill('SIGKILL'), timeoutMs + 10000);
    const finish = () => { clearTimeout(timer); clearTimeout(killer); fs.closeSync(fd); };
    child.once('error', error => { finish(); reject(error); });
    child.once('close', code => { if (child.pid) finish(); if (code !== 0 || expired) reject(new Error(`${script} failed (exit ${code}, timeout ${expired}); see ${logFile}`)); else resolve(events); });
  });
}

export function validateImages(dir, targetDate, event) {
  if (!event || event.date !== targetDate || !Number.isInteger(event.pages) || event.pages < 0 || !Array.isArray(event.files) || event.files.length !== event.pages) throw new Error('Missing or invalid story completion manifest');
  return event.files.map((name, i) => {
    if (name !== `story-${targetDate}-p${i + 1}.png`) throw new Error('Unexpected story filename/order');
    const file = path.join(dir, name);
    const data = fs.readFileSync(file);
    if (data.length < 24 || data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || data.readUInt32BE(16) !== 1080 || data.readUInt32BE(20) !== 1920) throw new Error('Invalid story PNG');
    return { file, sha256: digest(data.toString('base64')) };
  });
}

export async function runNightly({ projectDir, now = () => new Date(), execute = false, budgetUsd = 2,
  coverageMode = 'strict', deliver = false, recipient = '', fromAddress = '', child = runChild, sender = sendEmail } = {}) {
  const slot = slotFor(now());
  if (!slot) return { status: 'outside-window' };
  if (!['strict','best-effort'].includes(coverageMode)) throw Error('Invalid coverage mode');
  const fallback = readState(path.join(projectDir, '.hermes/fallback', `${slot.night}.json`));
  if (fallback && ['sending','submitted','verified'].includes(fallback.status)) return {status:'fallback-existing', messageId:fallback.messageId || null};
  const base = path.join(projectDir, '.hermes/nightly');
  const accountFile = path.join(base, 'account-coverage.json');
  const scope = refreshScope(projectDir);
  const checkpointFile = path.join(base, 'checkpoint.json');
  const jobDir = path.join(base, slot.night), jobFile = path.join(jobDir, 'job.json');
  const saved = readState(jobFile);
  const plan = saved?.plan || fetchPlan(slot, latestPipelineActivity(projectDir, scope), scope);
  if (!execute) return { status: 'plan-only', slot, plan, deliver: false };
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > 2) throw new Error('Nightly Apify budget must be >0 and <= $2');
  if (deliver && coverageMode === 'best-effort') throw Error('Best effort requires qualified connector delivery');
  if (deliver) validateEmailConfig(recipient, fromAddress);
  const release = lock(path.join(base, 'nightly.lock'));
  try {
    let job = readState(jobFile) || { slot, plan: { ...plan, budgetUsd }, scope, coverageMode, status: 'pending' };
    if (job.coverageMode && job.coverageMode !== coverageMode) throw Error('Job coverage mode changed; manual recovery required');
    if (deliver && job.connector) throw new Error('Connector delivery owns this job');
    if (job.scope !== scope || job.plan.budgetUsd !== budgetUsd) throw new Error('Job configuration changed; recover original job first');
    if (job.status === 'sent' || job.status === 'empty') return { status: job.status };
    writeState(jobFile, job);
    const env = {
      HERMES_STRICT_REFRESH: coverageMode === 'strict' ? 'true' : 'false', HERMES_COVERAGE_MODE: coverageMode, SCRAPER_BACKEND: 'apify', RESUME: 'false', RETRY_FAILED_CLUBS: 'false', TEST_CLUB: '', CATEGORY: '',
      MAX_CLUBS_TO_PROCESS: '100000', START_DAYS_AGO: '', START_DATE: job.plan.since.slice(0, 10),
      HERMES_FETCH_SINCE: job.plan.since, APIFY_RESULTS_LIMIT: String(job.plan.limit),
      APIFY_MAX_CHARGE_USD: String(job.plan.budgetUsd), HERMES_APIFY_STATE: path.join(jobDir, 'apify.json')
    };
    if (!job.refreshed) {
      const events = await child('main.js', [], { projectDir, env, logFile: path.join(jobDir, 'refresh.log') });
      const summary = events.findLast(e => e.t === 'summary')?.summary;
      if (!healthyPipeline(summary)) throw new Error('Refresh completion/health not confirmed');
      const report = events.findLast(e => e.t === 'coverage' && e.report)?.report;
      if (coverageMode === 'best-effort' && (!report || report.version !== 2 || !report.accounts || !Object.keys(report.accounts).length)) throw Error('Coverage report missing; cannot qualify delivery');
      if (coverageMode === 'strict' && report && !report.complete) throw Error('Strict coverage incomplete');
      job.observedCoverageReport = report || null; job.coverageReport = report || null;
      job.refreshed = true; job.summary = summary; job.coverage = events.filter(e => e.t === 'coverage'); writeState(jobFile, job);
    }
    {
      // Coverage watermark is the scheduled START, never completion (which can
      // miss posts arriving while the actor is running).
      const observed = job.observedCoverageReport || job.coverageReport;
      if (observed) {
        const next = advanceAccounts(readState(accountFile), observed, {scope, since:job.plan.since, scheduledAt:slot.scheduledAt});
        writeState(accountFile, next);
        job.observedCoverageReport = observed;
        job.coverageReport = qualifyOutstandingGaps(observed, next);
        writeState(jobFile, job);
      }
      if (job.coverageReport?.complete || (!job.coverageReport && coverageMode === 'strict')) writeState(checkpointFile, { scope, coveredFrom: slot.scheduledAt });
      recordPipelineActivity(projectDir,{startedAt:slot.scheduledAt,scope,summary:job.summary,allAccountsProcessed:true,sourceJob:slot.night});
      if (coverageMode === 'strict' && job.coverageReport && !job.coverageReport.complete) throw Error('Strict coverage incomplete: unresolved historical gaps');
    }
    if (Date.parse(now()) >= Date.parse(slot.cutoff)) throw new Error('Delivery window expired; saved refresh can still support the next job');
    if (!job.images) {
      const output = fs.mkdtempSync(path.join(jobDir, 'images-'));
      const events = await child('story.js', [`--date=${slot.targetDate}`, `--out=${output}`], { projectDir, env, logFile: path.join(jobDir, 'story.log'), timeoutMs: 120000 });
      job.images = validateImages(output, slot.targetDate, events.findLast(e => e.t === 'story:done'));
      job.status = job.images.length ? 'prepared' : 'empty'; writeState(jobFile, job);
    }
    if (!deliver || !job.images.length) return { status: job.status, pages: job.images.length };
    const recipientHash = digest(recipient), senderHash = digest(fromAddress);
    if (job.recipientHash && job.recipientHash !== recipientHash) throw new Error('Recipient changed during delivery');
    if (job.senderHash && job.senderHash !== senderHash) throw new Error('Sender changed during delivery');
    // Legacy per-page delivery states must never be silently converted to email.
    if (job.images.some(image => image.status)) throw new Error('Legacy delivery state requires manual review');
    if (job.emailStatus === 'sending') throw new Error('Uncertain prior email submission; inspect before retrying');
    job.recipientHash = recipientHash; job.senderHash = senderHash;
    if (job.emailStatus !== 'submitted') {
      if (Date.parse(now()) >= Date.parse(slot.cutoff)) throw new Error('Delivery window expired');
      for (const image of job.images) {
        if (digest(fs.readFileSync(image.file).toString('base64')) !== image.sha256) throw new Error('Image changed after rendering');
      }
      job.emailStatus = 'sending'; writeState(jobFile, job);
      await sender(job.images.map(image => image.file), recipient, { fromAddress, targetDate: slot.targetDate });
      job.emailStatus = 'submitted'; writeState(jobFile, job);
    }
    job.status = 'sent'; writeState(jobFile, job);
    return { status: 'sent', pages: job.images.length }; // submitted, not delivery receipt
  } finally { release(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const args = process.argv.slice(2);
  // No live entry point until both local config and an explicit command opt in.
  const config = readState(path.join(projectDir, '.hermes/nightly-config.json'), {});
  const execute = args.includes('--execute');
  if (execute && config.deliveryMode === 'connector') { console.error('Use connector-delivery.js prepare for connector mode'); process.exitCode = 1; }
  else if (execute && config.enabled !== true) { console.error('Nightly execution disabled; review configuration and approve activation first'); process.exitCode = 1; }
  else runNightly({ projectDir, execute, budgetUsd: config.budgetUsd ?? 2, deliver: execute && config.deliveryEnabled === true, recipient: config.recipient || '', fromAddress: config.fromAddress || '' })
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
