import { fetchApifyUsage } from '../web/apify-usage.js';

const limitsResponse = {
  data: {
    monthlyUsageCycle: { startAt: '2026-08-01T00:00:00.000Z', endAt: '2026-09-01T00:00:00.000Z' },
    limits: { maxMonthlyUsageUsd: 49, maxMonthlyActorComputeUnits: 100 },
    current: { monthlyUsageUsd: 12.345, monthlyActorComputeUnits: 30 }
  }
};

const fakeFetch = (status, body) => async (url, options) => {
  fakeFetch.calls.push({ url, options });
  return { ok: status >= 200 && status < 300, status, json: async () => body };
};
fakeFetch.calls = [];

beforeEach(() => { fakeFetch.calls = []; });

describe('fetchApifyUsage', () => {
  it('reads monthly spend against the plan cap', async () => {
    const usage = await fetchApifyUsage({ token: 'apify_tok', fetch: fakeFetch(200, limitsResponse) });

    expect(usage).toEqual({
      ok: true,
      usedUsd: 12.345,
      limitUsd: 49,
      cycleStart: '2026-08-01T00:00:00.000Z',
      cycleEnd: '2026-09-01T00:00:00.000Z'
    });
  });

  it('sends the token as a bearer header, never in the URL', async () => {
    await fetchApifyUsage({ token: 'apify_tok', fetch: fakeFetch(200, limitsResponse) });

    const [{ url, options }] = fakeFetch.calls;
    expect(url).toBe('https://api.apify.com/v2/users/me/limits');
    expect(url).not.toContain('apify_tok');
    expect(options.headers.Authorization).toBe('Bearer apify_tok');
  });

  it('reports a missing token without making a request', async () => {
    const usage = await fetchApifyUsage({ token: '', fetch: fakeFetch(200, limitsResponse) });

    expect(usage).toEqual({ ok: false, reason: 'APIFY_TOKEN is not set' });
    expect(fakeFetch.calls).toHaveLength(0);
  });

  it('turns an auth failure into a readable reason', async () => {
    const usage = await fetchApifyUsage({ token: 'bad', fetch: fakeFetch(401, { error: { type: 'invalid-token' } }) });
    expect(usage).toEqual({ ok: false, reason: 'Apify rejected the token (401)' });
  });

  it('survives a network error', async () => {
    const usage = await fetchApifyUsage({ token: 'x', fetch: async () => { throw new Error('ENOTFOUND'); } });
    expect(usage).toEqual({ ok: false, reason: 'Could not reach Apify: ENOTFOUND' });
  });
});
