import fs from 'node:fs';
import {classifyCoverage,advanceAccounts} from '../automation/coverage.js';
import {planRecovery} from '../automation/recovery-plan.js';
const f=JSON.parse(fs.readFileSync(new URL('./fixtures/coverage/2026-10-15-night.json',import.meta.url)));
const report=()=>classifyCoverage(f.items,f.input.username,f.input.resultsLimit,f.diagnostics);
test('October 15 replay: 45 real gaps and four separate rate advisories',()=>{
 const r=report();expect(r.complete).toBe(false);
 expect(Object.values(r.accounts).filter(a=>!a.complete)).toHaveLength(45);
 expect(Object.values(r.accounts).filter(a=>a.advisories.includes('daily-rate-exceeded'))).toHaveLength(4);
 expect(Object.values(r.accounts).filter(a=>a.status==='blocked')).toHaveLength(4);
 expect(Object.values(r.accounts).filter(a=>a.status==='ambiguous-empty')).toHaveLength(38);
 for(const h of ['msjrelayforlife','msjaviationclub','msjinteract','shss.missionsj']) {expect(r.accounts[h].complete).toBe(true);expect(r.accounts[h].posts).toBeLessThan(f.input.resultsLimit);}
});
test('owner and coauthor evidence never grant missing profile traversal',()=>{
 const r=report();
 expect(r.accounts.msjmedcorps.relatedContent).toContain('https://www.instagram.com/p/DeFSz9zPquj/');
 expect(r.accounts.msjmocktrial.relatedContent).toContain('https://www.instagram.com/p/DeQTvUyRR_Z/');
 for(const h of ['msjmedcorps','msjmocktrial']) {expect(r.accounts[h].complete).toBe(false);expect(r.accounts[h].status).toBe('absent-input');}
});
test('saturation remains blocking even with rate advisory',()=>{
 const r=classifyCoverage(f.items,f.input.username,2,f.diagnostics);
 expect(r.accounts.msjaviationclub.complete).toBe(false);expect(r.accounts.msjaviationclub.reasons).toContain('cap-reached');expect(r.accounts.msjaviationclub.advisories).toContain('daily-rate-exceeded');
});
test('real gaps survive state advancement',()=>{
 const r=report();const next=advanceAccounts(null,r,{scope:'s',since:'2026-10-03T07:00:00Z',scheduledAt:'2026-10-16T04:00:00Z'});
 for(const [h,a] of Object.entries(r.accounts)) if(!a.complete) expect(next.accounts[h].gapSince).toBe('2026-10-03T07:00:00Z');
});
const state=()=>({accounts:{quiet:{status:'ambiguous-empty',gapSince:'2026-10-01T00:00:00Z',lastAttempt:'2026-10-15T04:00:00Z'},blocked:{status:'blocked',gapSince:'2026-10-01T00:00:00Z',lastAttempt:'2026-10-15T04:00:00Z'},missing:{status:'missing-handle',gapSince:'2026-10-01T00:00:00Z'},cap:{status:'cap-reached',gapSince:'2026-10-01T00:00:00Z'},partial:{status:'partial-pagination',gapSince:'2026-10-01T00:00:00Z',lastAttempt:'2026-10-14T04:00:00Z'}}});
test('recovery defers quiet/blocked, requires handle/cap review, preserves gaps',()=>{
 const s=state(),before=JSON.stringify(s);const r=planRecovery(s,{now:'2026-10-16T04:00:00Z'});
 expect(r.canExecute).toBe(false);expect(r.budgetUsd).toBe(2);expect(r.proposed.map(a=>a.handle)).toEqual(['partial']);expect(r.proposed[0].since).toBe('2026-10-01T00:00:00Z');expect(r.deferred).toHaveLength(2);expect(r.manual).toHaveLength(2);expect(JSON.stringify(s)).toBe(before);
});
test('cached evidence precedes paid recovery',()=>expect(planRecovery(state(),{now:'2026-10-16T04:00:00Z',cachedAccounts:['partial']}).proposed).toHaveLength(0));
test('normal nightly attempt prevents extra immediate retry',()=>expect(planRecovery(state(),{now:'2026-10-16T04:00:00Z',priorAttempts:{partial:'2026-10-16T03:00:00Z'}}).proposed).toHaveLength(0));
test.each([0,3,-1,NaN])('invalid budget %s rejected',budgetUsd=>expect(()=>planRecovery(state(),{budgetUsd})).toThrow());
test('batch is limited and overflow remains visible',()=>{const s={accounts:Object.fromEntries(Array.from({length:9},(_,i)=>['a'+i,{status:'partial-pagination',gapSince:'2026-10-01T00:00:00Z'}]))};const r=planRecovery(s);expect(r.proposed).toHaveLength(5);expect(r.deferred).toHaveLength(4);});
test('invalid dates fail closed',()=>{const s=state();s.accounts.partial.lastAttempt='invalid';expect(planRecovery(s).manual.some(a=>a.handle==='partial')).toBe(true);});
