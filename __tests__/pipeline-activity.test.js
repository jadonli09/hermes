import {jest} from '@jest/globals';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {readState,writeState} from '../automation/state.js';
import {refreshScope} from '../automation/refresh-activity.js';
import {healthyPipeline,latestPipelineActivity,recordPipelineActivity,migratePipelineActivity,manualSourceHealthy} from '../automation/pipeline-activity.js';
import {runNightly,fetchPlan,slotFor,pacificInstant} from '../automation/nightly.js';
import {advanceAccounts,qualifyOutstandingGaps} from '../automation/coverage.js';
let root,scope;beforeEach(()=>{root=fs.mkdtempSync(path.join(os.tmpdir(),'hermes-pipeline-test-'));scope=refreshScope(root);});afterEach(()=>fs.rmSync(root,{recursive:true,force:true}));
const summary={totalClubs:2,clubsProcessed:2,clubsFailed:0,totalExtractionErrors:0,totalExtractionFailures:0};
const report={version:2,complete:false,accounts:{good:{status:'observed-window',complete:true,reasons:[]},bad:{status:'missing-handle',complete:false,reasons:['missing-handle']}}};
function saved(id,over={}){const file=path.join(root,'.hermes/nightly',id,'job.json');writeState(file,{scope,slot:{night:id,scheduledAt:pacificInstant(id,21)},plan:{since:pacificInstant('2026-10-03')},refreshed:true,summary,coverageReport:report,status:'sent',connector:{status:'verified',receipt:{messageId:'original'}},...over});return file;}
test('migrates healthy best-effort job without editing sent records or gap ledger',()=>{
 const file=saved('2026-10-18'),before=fs.readFileSync(file);
 const ledger=path.join(root,'.hermes/nightly/account-coverage.json');writeState(ledger,{scope,accounts:{bad:{gapSince:pacificInstant('2026-10-03')}}});const old=fs.readFileSync(ledger);
 expect(migratePipelineActivity(root,scope)).toMatchObject({coveredFrom:pacificInstant('2026-10-18',21),sourceJob:'2026-10-18'});
 expect(fs.readFileSync(file)).toEqual(before);expect(fs.readFileSync(ledger)).toEqual(old);
 expect(latestPipelineActivity(root,scope).coveredFrom).toBe(pacificInstant('2026-10-18',21));
});
test.each([
 ['interrupted',{refreshed:false}],['missing summary',{summary:null}],['failed clubs',{summary:{...summary,clubsFailed:1}}],
 ['incomplete selection',{summary:{...summary,clubsProcessed:1}}],['extraction errors',{summary:{...summary,totalExtractionErrors:1}}],
 ['extraction failures',{summary:{...summary,totalExtractionFailures:1}}],['empty selection',{summary:{...summary,totalClubs:0,clubsProcessed:0}}],['wrong scope',{scope:'different'}]
])('%s job cannot migrate as healthy activity',(_,over)=>{saved('2026-10-18',over);expect(latestPipelineActivity(root,scope)).toBeNull();});
test('successful refresh before a later render interruption still counts as processing activity',()=>{saved('2026-10-18',{status:'pending',images:undefined,connector:undefined});expect(latestPipelineActivity(root,scope).sourceJob).toBe('2026-10-18');});
test('new plan uses recent healthy run not missing-handle or failed-job floor',async()=>{
 saved('2026-10-18');saved('2026-10-01',{refreshed:false});writeState(path.join(root,'.hermes/nightly/account-coverage.json'),{scope,accounts:{bad:{gapSince:pacificInstant('2026-10-03')}}});
 const result=await runNightly({projectDir:root,now:()=>new Date('2026-10-20T04:00:00Z')});
 expect(result.plan).toMatchObject({since:'2026-10-16T07:00:00.000Z',limit:8,catchUp:false,reason:'rolling'});
 expect(fs.existsSync(path.join(root,'.hermes/pipeline-activity.json'))).toBe(false);
});
test('Thursday activity yields a Sunday window that overlaps Thursday',()=>{
 saved('2026-10-15');const p=fetchPlan(slotFor(new Date('2026-10-19T04:00:00Z')),latestPipelineActivity(root,scope),scope);
 expect(p).toMatchObject({since:'2026-10-15T07:00:00.000Z',limit:8,catchUp:false,reason:'rolling'});
});
test('a week without a healthy pipeline widens back to that run, not an arbitrary old gap',()=>{
 saved('2026-10-11');const p=fetchPlan(slotFor(new Date('2026-10-19T04:00:00Z')),latestPipelineActivity(root,scope),scope);
 expect(p).toMatchObject({since:pacificInstant('2026-10-11',21),limit:16,catchUp:true,reason:'extended-after-gap'});
});
test('account change bootstraps while retaining unchanged gaps and archiving removed handles',()=>{
 saved('2026-10-18');expect(latestPipelineActivity(root,'changed')).toBeNull();
 const p=fetchPlan(slotFor(new Date('2026-10-20T04:00:00Z')),latestPipelineActivity(root,'changed'),'changed');expect(p.limit).toBe(22);
 const prior={scope,accounts:{good:{gapSince:'2026-09-01T00:00:00Z'},removed:{gapSince:'2026-09-02T00:00:00Z'}}};
 const next=advanceAccounts(prior,{accounts:{good:{complete:true,status:'observed-window',reasons:[]}}},{scope:'changed',since:p.since,scheduledAt:'2026-10-20T04:00:00Z'});
 expect(next.accounts.good.gapSince).toBe(prior.accounts.good.gapSince);expect(next.previousScopes[0].accounts.removed).toEqual(prior.accounts.removed);
});
test('healthy full-scope manual processing counts despite source gaps; failed/subset processing does not',()=>{
 expect(recordPipelineActivity(root,{startedAt:'2026-10-19T04:00:00Z',scope,summary,allAccountsProcessed:true,sourceHealthy:true})).toBe(true);
 for(const args of [{summary:{...summary,clubsFailed:1},allAccountsProcessed:true,sourceHealthy:true},{summary,allAccountsProcessed:false,sourceHealthy:true},{summary,allAccountsProcessed:true,sourceHealthy:false},{summary,allAccountsProcessed:true}]) expect(recordPipelineActivity(root,{startedAt:'2026-10-20T04:00:00Z',scope,...args})).toBe(false);
 expect(latestPipelineActivity(root,scope).coveredFrom).toBe('2026-10-19T04:00:00Z');
});
test('historical gaps continue to qualify a clean narrow observed report',()=>{
 const observed={version:2,complete:true,accounts:{good:{complete:true,status:'observed-window',reasons:[]}}};const prior={scope,accounts:{good:{gapSince:'2026-10-03T07:00:00Z'}}};
 const next=advanceAccounts(prior,observed,{scope,since:'2026-10-19T04:00:00Z',scheduledAt:'2026-10-20T04:00:00Z'});const qualified=qualifyOutstandingGaps(observed,next);
 expect(qualified.complete).toBe(false);expect(qualified.warning).toBe('Refresh incomplete; newer events may be missing.');expect(qualified.accounts.good).toMatchObject({status:'historical-gap',observedWindowComplete:true,gapSince:'2026-10-03T07:00:00Z'});expect(observed.complete).toBe(true);
 const recovered=advanceAccounts(prior,observed,{scope,since:'2026-10-03T07:00:00Z',scheduledAt:'2026-10-20T04:00:00Z'});expect(qualifyOutstandingGaps(observed,recovered).complete).toBe(true);
});
test('new healthy best-effort execution records activity yet preserves historical warning',async()=>{
 saved('2026-10-18');const ledger=path.join(root,'.hermes/nightly/account-coverage.json');writeState(ledger,{scope,accounts:{good:{gapSince:pacificInstant('2026-10-03')}}});
 const observed={version:2,complete:true,accounts:{good:{complete:true,status:'observed-window',reasons:[]}}};
 const child=jest.fn(async(script,args)=>{if(script==='main.js')return [{t:'summary',summary},{t:'coverage',report:observed}];return [{t:'story:done',date:'2026-10-20',pages:0,files:[]}];});
 await runNightly({projectDir:root,now:()=>new Date('2026-10-20T04:00:00Z'),execute:true,coverageMode:'best-effort',child});
 expect(readState(path.join(root,'.hermes/pipeline-activity.json')).coveredFrom).toBe('2026-10-20T04:00:00.000Z');
 const job=readState(path.join(root,'.hermes/nightly/2026-10-19/job.json'));expect(job.observedCoverageReport.complete).toBe(true);expect(job.coverageReport.complete).toBe(false);expect(readState(ledger).accounts.good.gapSince).toBe(pacificInstant('2026-10-03'));
 expect(readState(path.join(root,'.hermes/nightly/checkpoint.json'))).toBeNull();
});

const blockedReport=(b,total)=>({version:2,complete:false,accounts:Object.fromEntries(Array.from({length:total},(_,i)=>[`a${i}`,i<b?{status:'blocked',complete:false,reasons:['blocked']}:{status:'observed-window',complete:true,reasons:[]}]))});
test('blocked run is not recorded as activity',()=>{
 expect(recordPipelineActivity(root,{startedAt:'2026-10-20T04:00:00Z',scope,summary,allAccountsProcessed:true,sourceHealthy:false})).toBe(false);
 expect(fs.existsSync(path.join(root,'.hermes/pipeline-activity.json'))).toBe(false);
});
test('stale v1 activity from a blocked night does not narrow the window',()=>{
 writeState(path.join(root,'.hermes/pipeline-activity.json'),{version:1,scope,coveredFrom:'2026-10-20T04:00:00.000Z',sourceJob:'2026-10-19'});
 saved('2026-10-18',{coverageReport:blockedReport(4,93)});saved('2026-10-19',{coverageReport:blockedReport(90,93),observedCoverageReport:blockedReport(90,93)});
 expect(latestPipelineActivity(root,scope).coveredFrom).toBe(pacificInstant('2026-10-18',21));
});
test('job without a coverage report never counts as healthy activity',()=>{
 saved('2026-10-18',{coverageReport:undefined});expect(latestPipelineActivity(root,scope)).toBeNull();
});
test('blocked nightly still renders but does not advance activity',async()=>{
 saved('2026-10-18');
 const child=jest.fn(async(script)=>script==='main.js'?[{t:'summary',summary},{t:'coverage',report:blockedReport(90,93)}]:[{t:'story:done',date:'2026-10-20',pages:0,files:[]}]);
 const result=await runNightly({projectDir:root,now:()=>new Date('2026-10-20T04:00:00Z'),execute:true,coverageMode:'best-effort',child});
 expect(result.status).toBe('empty');
 const job=readState(path.join(root,'.hermes/nightly/2026-10-19/job.json'));expect(job.sourceHealth).toEqual({healthy:false,blocked:90,requested:93});
 expect(readState(path.join(root,'.hermes/pipeline-activity.json'))).toBeNull();
 expect(latestPipelineActivity(root,scope).coveredFrom).toBe(pacificInstant('2026-10-18',21));
});
test('manual runs: Playwright counts as healthy, Apify needs an unblocked report',()=>{
 expect(manualSourceHealthy('playwright',undefined)).toBe(true);
 expect(manualSourceHealthy('apify',blockedReport(90,93))).toBe(false);
 expect(manualSourceHealthy('apify',blockedReport(4,93))).toBe(true);
 expect(manualSourceHealthy('apify',undefined)).toBe(false);
});
