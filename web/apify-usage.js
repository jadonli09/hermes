// Apify publishes the account's month-to-date spend and plan cap on one
// endpoint, so unlike Claude this is real usage, not an estimate.
//
// The token goes in a header rather than the ?token= query form Apify also
// accepts: query strings end up in proxy logs and browser history.
const LIMITS_URL = 'https://api.apify.com/v2/users/me/limits';

export async function fetchApifyUsage({ token, fetch = globalThis.fetch }) {
  if (!token) return { ok: false, reason: 'APIFY_TOKEN is not set' };

  let response;
  try {
    response = await fetch(LIMITS_URL, { headers: { Authorization: `Bearer ${token}` } });
  } catch (error) {
    return { ok: false, reason: `Could not reach Apify: ${error.message}` };
  }

  if (!response.ok) {
    return { ok: false, reason: `Apify rejected the token (${response.status})` };
  }

  const { data } = await response.json();
  return {
    ok: true,
    usedUsd: data.current?.monthlyUsageUsd ?? 0,
    limitUsd: data.limits?.maxMonthlyUsageUsd ?? null,
    cycleStart: data.monthlyUsageCycle?.startAt ?? null,
    cycleEnd: data.monthlyUsageCycle?.endAt ?? null
  };
}
