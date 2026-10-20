// One durable start intent per logical request. Never retry a paid POST: a lost
// response is ambiguous. GET failures can safely retry against the saved run ID.
import path from 'node:path';
import { parseActorDiagnostics } from '../automation/coverage.js';
import fs from 'node:fs';
import { readState, writeState, digest, lock } from '../automation/state.js';
import { retryWithBackoff } from '../utils/retry.js';

const API = 'https://api.apify.com/v2';
const ACTIVE = new Set(['READY', 'RUNNING', 'TIMING-OUT', 'ABORTING']);

export async function runActor({ token, actorId, input, maxItems, maxTotalChargeUsd = 2,
  statePath = process.env.HERMES_APIFY_STATE || path.resolve('.hermes/apify', `${digest({ actorId })}.json`),
  ledgerPath = path.resolve('.hermes/apify', `${digest(actorId)}-outstanding.json`),
  onDiagnostics = () => {}, fetchFn = globalThis.fetch, sleep = ms => new Promise(r => setTimeout(r, ms)),
  now = Date.now, pollMs = 5000, maxPollMs = 20 * 60 * 1000 }) {
  if (!Number.isFinite(maxTotalChargeUsd) || maxTotalChargeUsd <= 0) throw new Error('A positive finite Apify budget is required');
  let requestKey = digest({ actorId, input, maxItems, maxTotalChargeUsd });
  const releaseLedger = lock(`${ledgerPath}.lock`);
  let release;
  try {
    release = lock(`${statePath}.lock`);
    const outstanding = readState(ledgerPath);
    if (outstanding && outstanding.statePath !== statePath) throw new Error(`Unresolved paid request; recover ${outstanding.statePath} first`);
    let state = readState(statePath);
    // A normal completed manual run may start fresh next time. Scheduled runs
    // keep their cache indefinitely under their own immutable job directory.
    if (state?.acknowledged && !process.env.HERMES_APIFY_STATE) state = null;
    if (state && state.requestKey !== requestKey) {
      // Selection randomizes processing order. A known paid run may reuse its
      // saved order only when exact unique membership matches. Re-hashing ALL
      // other request fields against the original key preserves fail-closed
      // validation for dates, limits, actor, budget, extra fields and maxItems.
      const current = input?.username, saved = state.input?.username;
      const valid = xs => Array.isArray(xs) && xs.length > 0 &&
        xs.every(x => typeof x === 'string' && x.length > 0) && new Set(xs).size === xs.length;
      const sameMembers = valid(current) && valid(saved) &&
        JSON.stringify([...current].sort()) === JSON.stringify([...saved].sort());
      const restored = sameMembers ? { ...input, username: [...saved] } : null;
      const restoredKey = restored && digest({ actorId, input: restored, maxItems, maxTotalChargeUsd });
      if (!state.runId || !state.datasetId || restoredKey !== state.requestKey) {
        throw new Error('Apify checkpoint input changed; recover the original job first');
      }
      input = restored;
      requestKey = restoredKey;
    }
    const inspectLog = async () => {
      if (!process.env.HERMES_COVERAGE_MODE) return;
      if (!state.diagnostics) {
        try {
          const response = await fetchFn(`${API}/logs/${state.runId}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
          if (!response.ok) throw Error('Log unavailable');
          state.diagnostics = parseActorDiagnostics(await response.text());
        } catch { state.diagnostics = { logAvailable: false, partialInputs: [], unscopedFailure: true }; }
        writeState(statePath, state);
      }
      onDiagnostics(state.diagnostics);
    };
    if (state?.items) {
      await inspectLog();
      if (readState(ledgerPath)?.statePath === statePath) fs.unlinkSync(ledgerPath);
      return state.items;
    }
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const request = async (url, options = {}) => {
      const response = await fetchFn(url, { ...options, headers, signal: AbortSignal.timeout(30000) });
      if (!response.ok) {
        // Do not echo request URLs, bearer tokens, or provider response bodies.
        const error = new Error(`Apify HTTP ${response.status}`); error.status = response.status; throw error;
      }
      return response;
    };
    const get = url => retryWithBackoff(() => request(url), { maxRetries: 2, initialDelay: 1000, maxDelay: 5000 });
    if (!state) {
      state = { requestKey, actorId, input, budgetUsd: maxTotalChargeUsd, status: 'starting', startedAt: new Date(now()).toISOString() };
      writeState(ledgerPath, { statePath });
      writeState(statePath, state); // Reserve entire budget before the only POST.
      const params = new URLSearchParams({ maxTotalChargeUsd: String(maxTotalChargeUsd), timeout: '1200', restartOnError: 'false' });
      if (maxItems) params.set('maxItems', String(maxItems));
      const response = await request(`${API}/actors/${actorId.replace('/', '~')}/runs?${params}`, { method: 'POST', body: JSON.stringify(input) });
      const { data } = await response.json();
      if (!data?.id || !data.defaultDatasetId) throw new Error('Apify start response lacked run/dataset ID; manual reconciliation required');
      state = { ...state, runId: data.id, datasetId: data.defaultDatasetId, status: data.status };
      writeState(statePath, state);
    }
    if (!state.runId) throw new Error('Ambiguous Apify start: reconcile the existing run in Console and checkpoint before retrying; no new paid run started');
    const deadline = now() + maxPollMs;
    // Always query saved ID, including after an interruption or terminal failure.
    let run;
    do {
      ({ data: run } = await (await get(`${API}/actor-runs/${state.runId}`)).json());
      if (!run?.status) throw new Error('Invalid Apify run response');
      state.status = run.status;
      writeState(statePath, state);
      if (!ACTIVE.has(run.status)) break;
      if (now() >= deadline) throw new Error(`Apify polling timed out; resume saved run ${state.runId}`);
      await sleep(pollMs);
    } while (true);
    if (run.status !== 'SUCCEEDED') throw new Error(`Saved Apify run ${state.runId} ended ${run.status}; no replacement run started`);
    if (/max.*(charge|paid|cost)|budget|payment|cost.*limit/i.test(run.statusMessage || '') ||
        (Number.isFinite(run.usageTotalUsd) && run.usageTotalUsd >= maxTotalChargeUsd)) {
      throw new Error('Apify budget reached; coverage is uncertain. No new paid run started');
    }
    const items = [];
    let offset = 0, expectedTotal = null;
    // Retry inconsistent reads of the SAME dataset/offset, never a paid start.
    // Do not append a batch until all available pagination evidence agrees.
    while (true) {
      let batch, total;
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await get(`${API}/datasets/${state.datasetId}/items?format=json&offset=${offset}&limit=1000`);
        batch = await response.json();
        if (!Array.isArray(batch)) throw new Error('Invalid Apify dataset');
        const numberHeader = name => {
          const raw = response.headers.get(`x-apify-pagination-${name}`);
          return raw === null ? null : /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : NaN;
        };
        total = numberHeader('total');
        const count = numberHeader('count'), returnedOffset = numberHeader('offset');
        const invalid = batch.length > 1000 ||
          (total !== null && (!Number.isFinite(total) || total < offset + batch.length)) ||
          (count !== null && count !== batch.length) ||
          (returnedOffset !== null && returnedOffset !== offset) ||
          (expectedTotal !== null && total !== expectedTotal) ||
          (total !== null && offset < total && !batch.length);
        if (!invalid) break;
        const diagnostic = `offset=${offset}, rows=${batch.length}, total=${total}, count=${count}, returnedOffset=${returnedOffset}, expectedTotal=${expectedTotal}`;
        if (attempt === 2) throw new Error(`Invalid dataset pagination after 3 reads (${diagnostic}); saved actor retained`);
        console.warn(`Inconsistent dataset pagination (${diagnostic}); retrying same dataset page`);
        await sleep(250 * (attempt + 1));
      }
      if (total !== null) expectedTotal = total;
      items.push(...batch); offset += batch.length;
      if (total !== null ? offset >= total : batch.length < 1000) break;
    }
    await inspectLog();
    state.items = items; state.completedAt = new Date(now()).toISOString();
    writeState(statePath, state);
    if (readState(ledgerPath)?.statePath === statePath) fs.unlinkSync(ledgerPath);
    return items;
  } finally { release?.(); releaseLedger(); }
}

// Called only AFTER Sheets writes and pipeline health checks succeed.
export function acknowledgeActorRun(actorId, input) {
  if (process.env.HERMES_APIFY_STATE) return;
  const file = path.resolve('.hermes/apify', `${digest({ actorId })}.json`);
  const state = readState(file);
  if (state?.items) writeState(file, { ...state, acknowledged: true });
}
