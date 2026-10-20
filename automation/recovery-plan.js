// Read-only proposal. Never starts an actor, changes coverage or retries delivery.
// This is additional gap recovery, not a replacement for the normal nightly scan.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const DAY=86400000;
const intervals={ 'ambiguous-empty':7, blocked:3, 'absent-input':3, 'partial-pagination':1, 'diagnostics-unknown':1, 'unusable-row':1, 'provider-error':3, 'unmapped-row':3 };
export function planRecovery(state, {now=new Date(), maxAccounts=5, budgetUsd=2, cachedAccounts=[], priorAttempts={}}={}) {
  if (!Number.isInteger(maxAccounts) || maxAccounts<1 || maxAccounts>5) throw Error('Recovery batch must contain 1–5 accounts');
  if (!Number.isFinite(budgetUsd) || budgetUsd<=0 || budgetUsd>2) throw Error('Recovery budget must be >0 and <= $2');
  const instant=Date.parse(now); if (!Number.isFinite(instant)) throw Error('Invalid recovery date');
  const candidates=[], deferred=[], manual=[];
  for (const [handle,a] of Object.entries(state?.accounts || {}).sort(([a],[b])=>a.localeCompare(b))) {
    if (!a.gapSince) continue;
    const record={handle,status:a.status,since:a.gapSince};
    const reasons=new Set([a.status,...(a.reasons||[])]);
    if (!Number.isFinite(Date.parse(a.gapSince))) { manual.push({...record,reason:'invalid-gap-date'});continue; }
    if (reasons.has('missing-handle')) {manual.push({...record,reason:'verify-handle-no-automatic-retry'});continue;}
    if (cachedAccounts.includes(handle)) {deferred.push({...record,reason:'inspect-existing-cache-first'});continue;}
    if (reasons.has('cap-reached')) {manual.push({...record,reason:'review-cap-and-cost-before-expansion'});continue;}
    const days=Math.max(1,...[...reasons].map(x=>intervals[x]||1));
    // Include normal nightly attempts: an extra recovery pass must not duplicate
    // a recent regular scan. Caller-supplied retry history cannot shorten this.
    const raw=[a.lastAttempt,priorAttempts[handle]].filter(Boolean);
    if(raw.some(x=>!Number.isFinite(Date.parse(x)))) {manual.push({...record,reason:'invalid-attempt-date'});continue;}
    const last=Math.max(-Infinity,...raw.map(x=>Date.parse(x)));
    const due=last+days*DAY;
    if (instant<due) deferred.push({...record,reason:'backoff',nextEligibleAt:new Date(due).toISOString()});
    else candidates.push({...record,minimumRetryDays:days});
  }
  // Oldest preserved gap first. Budget is shared with the nightly actor, never
  // an additional allowance. No price estimate can safely authorize a POST.
  candidates.sort((a,b)=>Date.parse(a.since)-Date.parse(b.since)||a.handle.localeCompare(b.handle));
  const proposed=candidates.slice(0,maxAccounts);
  deferred.push(...candidates.slice(maxAccounts).map(a=>({...a,reason:'batch-limit'})));
  return {mode:'review-only',canExecute:false,budgetUsd,proposed,deferred,manual,
    requirements:['Use cached actor data and URL/extraction dedup first.', 'Inspect outstanding actor intents and actual cost before any paid run.', 'Total Apify spending shares the existing $2 slot cap; Claude costs are separate.', 'Preserve original gap dates until a clean window covers them.', 'Do not modify sent jobs or delivery claims.']};
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const file=process.argv[2]; if(!file) throw Error('Usage: node automation/recovery-plan.js <account-coverage.json> [ISO date]');
  console.log(JSON.stringify(planRecovery(JSON.parse(fs.readFileSync(file,'utf8')), {now:process.argv[3] || new Date()}),null,2));
}
