// Coverage is independent of successful extraction/Sheet writes. Unknown is not empty.
export const COVERAGE_WARNING = 'Refresh incomplete; newer events may be missing.';
const account = value => String(value || '').match(/instagram\.com\/([^/?#]+)/i)?.[1]?.toLowerCase();
export function parseActorDiagnostics(log) {
  const partialInputs = [...String(log).matchAll(/pagination request failed[^\n]*"origin":"([^\"]+)"/g)].map(m => account(m[1])).filter(Boolean);
  const stats = [...String(log).matchAll(/Final request statistics: (\{[^\n]+\})/g)].at(-1);
  let failed = null;
  try { failed = JSON.parse(stats?.[1]).requestsFailed; } catch { /* unknown */ }
  return { logAvailable: Number.isInteger(failed), partialInputs, unscopedFailure: failed === null || (failed > partialInputs.length) };
}
export function classifyCoverage(items, usernames, limit, diagnostics = {}) {
  const accounts = Object.fromEntries(usernames.map(n => [n.toLowerCase(), { status:'absent-input', complete:false, posts:0, reasons:[], advisories:[] }]));
  const rows = new Map(), unknown = [];
  for (const row of items) {
    const key = account(row.inputUrl) || (row.username || row.ownerUsername || '').toLowerCase() || account(row.url);
    const related = [row.ownerUsername, ...(row.coauthorProducers || []).map(x=>x.username)];
    for (const handle of new Set(related.filter(Boolean))) {
      const target = accounts[String(handle).toLowerCase()];
      if (target && row.url && !row.error) { target.relatedContent ||= []; if (!target.relatedContent.includes(row.url)) target.relatedContent.push(row.url); }
    }
    if (!accounts[key]) { unknown.push('unmapped-row'); continue; }
    if (!rows.has(key)) rows.set(key, []); rows.get(key).push(row);
  }
  for (const [key, result] of Object.entries(accounts)) {
    const list = rows.get(key) || [], reasons = new Set();
    const valid = list.filter(x => !x.error && !x.errorDescription && /^https?:\/\/(?:www\.)?instagram\.com\/(p|reel|tv)\//.test(x.url || '') && Number.isFinite(Date.parse(x.timestamp)));
    const posts = [...new Map(valid.map(x => [x.url,x])).values()]; result.posts = posts.length;
    if (!list.length) reasons.add('absent-input');
    for (const row of list) {
      if (row.requestErrorMessages?.length) reasons.add('blocked');
      if (row.error === 'not_found') reasons.add('missing-handle');
      else if (row.error === 'no_items' && !row.requestErrorMessages?.length) reasons.add('ambiguous-empty');
      else if (row.error && row.error !== 'no_items') reasons.add('provider-error');
      else if (!row.error && !valid.includes(row)) reasons.add('unusable-row');
    }
    if (diagnostics.partialInputs?.includes(key)) reasons.add('partial-pagination');
    if (!diagnostics.logAvailable || diagnostics.unscopedFailure) reasons.add('diagnostics-unknown');
    if (unknown.length) reasons.add('unmapped-row');
    if (posts.length >= limit) reasons.add('cap-reached');
    const days = new Map();
    for (const p of posts) { const day = new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles'}).format(new Date(p.timestamp)); days.set(day,(days.get(day)||0)+1); }
    result.maxPostsPerPacificDay = Math.max(0,...days.values());
    if (result.maxPostsPerPacificDay > 1) result.advisories.push('daily-rate-exceeded');
    // Rate deviations inform future sizing. Actual saturation remains a gap.
    result.cap = limit;
    // Current provider schema never positively attests that an empty window is
    // public, fully traversed and empty. Do not manufacture confirmed-empty.
    const priority=['blocked','missing-handle','partial-pagination','absent-input','ambiguous-empty','provider-error','unusable-row','cap-reached','diagnostics-unknown','unmapped-row'];
    result.reasons=[...reasons]; result.status=priority.find(x=>reasons.has(x)) || 'observed-window'; result.complete=reasons.size===0 && posts.length>0;
  }
  const complete = Object.values(accounts).length>0 && Object.values(accounts).every(x=>x.complete);
  return { version:2, complete, warning:complete ? null : COVERAGE_WARNING, accounts, diagnostics };
}
// Healthy nights see 0-4 of 93 accounts blocked; Instagram outages block ~90.
// Only a healthy run may advance the watermark or skip the email warning.
export const BLOCKED_RATIO_LIMIT = 0.25;
export function sourceHealth(report) {
  const accounts = Object.values(report?.accounts || {});
  const blocked = accounts.filter(x => x.reasons?.includes('blocked')).length;
  const requested = accounts.length;
  return { healthy: requested > 0 && blocked / requested <= BLOCKED_RATIO_LIMIT, blocked, requested };
}
export function blockedWarning({ blocked, requested }, lookbackDays) {
  return `Instagram blocked the scraper for ${blocked} of ${requested} clubs tonight, so their newest posts may be missing from these images. The next nightly run automatically re-checks at least the last ${lookbackDays} days.`;
}
export function advanceAccounts(previous, report, {scope,since,scheduledAt}) {
  const state = previous?.scope===scope ? structuredClone(previous) : {version:1,scope,accounts:{},
    ...(previous ? {previousScopes:[...(previous.previousScopes || []),{scope:previous.scope,accounts:structuredClone(previous.accounts || {})}]} : {})};
  // A configuration change bootstraps retrieval, but is not evidence that any
  // unchanged account's old gap disappeared. Removed handles remain archived.
  if(previous && previous.scope!==scope) for(const name of Object.keys(report.accounts)) {
    if(previous.accounts?.[name]) state.accounts[name]=structuredClone(previous.accounts[name]);
  }
  for (const [name,result] of Object.entries(report.accounts)) {
    const old=state.accounts[name] || {};
    // A later clean window cannot erase an earlier gap it did not retrieve.
    const floor=old.gapSince || old.coveredFrom || since;
    const coversGap=Date.parse(since)<=Date.parse(floor);
    state.accounts[name]={...old,lastAttempt:scheduledAt,status:result.status,reasons:result.reasons,advisories:result.advisories || []};
    if (result.complete && coversGap) { state.accounts[name].coveredFrom=scheduledAt; delete state.accounts[name].gapSince; }
    else state.accounts[name].gapSince=old.gapSince || old.coveredFrom || since;
  }
  return state;
}
export function coverageFloor(state, scope) {
  if (state?.scope!==scope) return null;
  const dates=Object.values(state.accounts).map(x=>x.gapSince || x.coveredFrom).filter(Boolean);
  if (!dates.length) return null;
  if (dates.some(x=>!Number.isFinite(Date.parse(x)))) throw Error('Invalid account coverage date');
  return {scope,coveredFrom:dates.sort((a,b)=>Date.parse(a)-Date.parse(b))[0]};
}

// Qualify publication with historical gaps without changing observed evidence.
// A clean narrow window is useful but cannot prove an older gap was recovered.
export function qualifyOutstandingGaps(report,state) {
  const result=structuredClone(report);
  for(const [name,account] of Object.entries(state?.accounts || {})) {
    if(!account.gapSince) continue;
    const current=result.accounts[name] || {status:'absent-input',complete:false,posts:0,reasons:['absent-input'],advisories:[]};
    current.observedWindowComplete=current.complete===true;
    current.gapSince=account.gapSince;
    if(current.complete) {
      current.complete=false;current.status='historical-gap';
      current.reasons=[...new Set([...(current.reasons || []),'historical-gap'])];
    }
    result.accounts[name]=current;
  }
  result.complete=Object.values(result.accounts).length>0 && Object.values(result.accounts).every(x=>x.complete);
  result.warning=result.complete ? null : COVERAGE_WARNING;
  return result;
}
