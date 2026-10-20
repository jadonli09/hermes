// Successful all-account processing is activity, not proof of source coverage.
import fs from 'node:fs';
import path from 'node:path';
import { readState, writeState } from './state.js';
import { sourceHealth } from './coverage.js';
export function healthyPipeline(summary) {
  return !!summary && Number.isInteger(summary.totalClubs) && summary.totalClubs > 0 &&
    summary.clubsProcessed === summary.totalClubs && summary.clubsFailed === 0 &&
    summary.totalExtractionErrors === 0 && (summary.totalExtractionFailures ?? 0) === 0;
}
export function latestPipelineActivity(projectDir, scope) {
  const saved=readState(path.join(projectDir,'.hermes/pipeline-activity.json'));
  // Version-1 records (and the legacy refresh checkpoint) predate the source
  // health gate; a blocked night wrote one, so they are not trusted.
  const candidates=[saved].filter(x=>x?.scope===scope && x.version===2 && x.sourceHealthy===true);
  const base=path.join(projectDir,'.hermes/nightly');
  if(fs.existsSync(base)) for(const id of fs.readdirSync(base).filter(n=>/^\d{4}-\d{2}-\d{2}$/.test(n))) {
    const job=readState(path.join(base,id,'job.json'));
    if(job?.scope!==scope || job.refreshed!==true || !healthyPipeline(job.summary)) continue;
    if(job.slot?.night!==id || !job.slot?.scheduledAt || !job.plan?.since) continue;
    if(!sourceHealth(job.observedCoverageReport || job.coverageReport).healthy) continue;
    // A successful refresh counts even if later rendering/delivery failed.
    candidates.push({version:1,scope,coveredFrom:job.slot.scheduledAt,sourceJob:id});
  }
  for(const c of candidates) if(!Number.isFinite(Date.parse(c.coveredFrom))) throw Error('Invalid pipeline activity timestamp');
  return candidates.sort((a,b)=>Date.parse(b.coveredFrom)-Date.parse(a.coveredFrom))[0] || null;
}
export function recordPipelineActivity(projectDir,{startedAt,scope,summary,allAccountsProcessed,sourceHealthy,sourceJob}) {
  if(!allAccountsProcessed || !healthyPipeline(summary) || sourceHealthy!==true) return false;
  if(!Number.isFinite(Date.parse(startedAt))) throw Error('Invalid pipeline activity timestamp');
  const file=path.join(projectDir,'.hermes/pipeline-activity.json');
  const old=readState(file);
  const trusted=old?.scope===scope && old.version===2 && old.sourceHealthy===true;
  if(trusted && !Number.isFinite(Date.parse(old.coveredFrom))) throw Error('Invalid pipeline activity timestamp');
  if(trusted && Date.parse(old.coveredFrom)>Date.parse(startedAt)) return false;
  writeState(file,{version:2,scope,coveredFrom:startedAt,sourceHealthy:true,...(sourceJob?{sourceJob}:{})});return true;
}
// Explicit local migration writes ONLY the new activity record. It never edits
// a historical job, paid intent, coverage ledger, image or delivery receipt.
export function migratePipelineActivity(projectDir,scope) {
  const activity=latestPipelineActivity(projectDir,scope);
  // Every candidate latestPipelineActivity returns passed the health gate.
  if(activity) writeState(path.join(projectDir,'.hermes/pipeline-activity.json'),{...activity,version:2,sourceHealthy:true});
  return activity;
}
