// Minimal Apify REST client - avoids pulling in the full apify-client SDK for the
// three endpoints we need. https://docs.apify.com/api/v2
import { retryWithBackoff } from '../utils/retry.js';

const API_BASE = 'https://api.apify.com/v2';

// The sync endpoint hard-fails at 300s; leave headroom so we fall back cleanly
const SYNC_TIMEOUT_SECONDS = 270;
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_MS = 15 * 60 * 1000;

/**
 * Actor IDs are written as "owner/name" but the API path wants "owner~name"
 */
function toActorPath(actorId) {
  return actorId.replace('/', '~');
}

async function apifyRequest(url, options = {}) {
  const response = await fetch(url, options);

  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      detail = body?.error?.message || '';
    } catch {
      // non-JSON error body, status alone will have to do
    }

    const error = new Error(
      `Apify API ${response.status}${detail ? `: ${detail}` : ''}`
    );
    error.status = response.status;

    // Make the common misconfigurations obvious rather than generic HTTP noise
    if (response.status === 401) {
      error.message += ' (check APIFY_TOKEN)';
    } else if (response.status === 404) {
      error.message += ' (check APIFY_ACTOR_ID - actor may not exist or may be private)';
    } else if (response.status === 402) {
      error.message += ' (Apify account is out of credit)';
    }

    throw error;
  }

  return response;
}

/**
 * Runs an actor and returns its dataset items.
 *
 * Tries the synchronous endpoint first (one request, no polling). That endpoint
 * returns 408 if the run exceeds 300s, in which case we start an async run and
 * poll instead - the run itself is unaffected either way.
 *
 * @param {Object} options
 * @param {string} options.token - Apify API token
 * @param {string} options.actorId - e.g. "apify/instagram-post-scraper"
 * @param {Object} options.input - Actor input payload
 * @param {number} [options.maxItems] - Cap on billed dataset items
 * @param {number} [options.maxTotalChargeUsd] - Hard ceiling on run cost
 * @returns {Promise<Array<Object>>} - Dataset items
 */
export async function runActor({ token, actorId, input, maxItems, maxTotalChargeUsd }) {
  const actorPath = toActorPath(actorId);
  const params = new URLSearchParams({ token, format: 'json', clean: '1' });

  if (maxItems) params.set('maxItems', String(maxItems));
  if (maxTotalChargeUsd) params.set('maxTotalChargeUsd', String(maxTotalChargeUsd));

  const body = JSON.stringify(input);
  const headers = { 'content-type': 'application/json' };

  try {
    const syncParams = new URLSearchParams(params);
    syncParams.set('timeout', String(SYNC_TIMEOUT_SECONDS));

    const response = await retryWithBackoff(
      () => apifyRequest(
        `${API_BASE}/actors/${actorPath}/run-sync-get-dataset-items?${syncParams}`,
        { method: 'POST', headers, body }
      ),
      { maxRetries: 2, initialDelay: 5000, maxDelay: 30000 }
    );

    return await response.json();
  } catch (error) {
    if (error.status !== 408) {
      throw error;
    }
    console.log('  Apify sync run exceeded 300s, switching to async polling...');
  }

  return await runActorAsync({ token, actorPath, input, params });
}

/**
 * Fallback path: start the run, poll until it settles, then read the dataset.
 */
async function runActorAsync({ token, actorPath, input, params }) {
  const startResponse = await apifyRequest(
    `${API_BASE}/actors/${actorPath}/runs?${params}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input)
    }
  );

  const { data: run } = await startResponse.json();
  console.log(`  Apify run ${run.id} started, polling...`);

  const deadline = Date.now() + MAX_POLL_MS;
  let status = run.status;
  let datasetId = run.defaultDatasetId;

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

    const pollResponse = await apifyRequest(
      `${API_BASE}/actor-runs/${run.id}?token=${token}`
    );
    const { data } = await pollResponse.json();

    status = data.status;
    datasetId = data.defaultDatasetId || datasetId;

    if (status !== 'RUNNING' && status !== 'READY') {
      break;
    }
  }

  if (status !== 'SUCCEEDED') {
    throw new Error(`Apify run ${run.id} ended with status ${status}`);
  }

  const itemsResponse = await apifyRequest(
    `${API_BASE}/datasets/${datasetId}/items?token=${token}&format=json&clean=1`
  );

  return await itemsResponse.json();
}
