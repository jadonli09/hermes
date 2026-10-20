import fs from 'node:fs';
import { classifyCoverage, parseActorDiagnostics, advanceAccounts, coverageFloor, sourceHealth, blockedWarning } from '../automation/coverage.js';
const fixture=name=>JSON.parse(fs.readFileSync(new URL(`./fixtures/coverage/${name}.json`,import.meta.url)));
const reportFor=name=>{const f=fixture(name);return classifyCoverage(f.items,f.input.username,f.input.resultsLimit,parseActorDiagnostics(f.log));};
test('real current dataset distinguishes blocked empties, absent accounts, missing handle and dropped pages',()=>{
 const r=reportFor('2026-10-13-night');
 expect(r.accounts['msj.ce'].status).toBe('blocked');
 expect(r.accounts.msjdatascience.status).toBe('missing-handle');
 expect(r.accounts.msjcivicsclub.status).toBe('absent-input');
 expect(r.accounts.msjneuroscience.status).toBe('absent-input');
 expect(r.accounts['msj.mun'].status).toBe('partial-pagination');
 expect(r.accounts.msjhs2029.status).toBe('ambiguous-empty');
 expect(Object.values(r.accounts).filter(x=>x.status==='blocked')).toHaveLength(3);
 expect(Object.values(r.accounts).filter(x=>x.status==='ambiguous-empty')).toHaveLength(44);
 expect(r.complete).toBe(false);
});
test.each(['2026-10-13-day','2026-10-06','2026-09-29'])('historical successful %s still has genuine coverage gaps',name=>{
 const r=reportFor(name);expect(r.complete).toBe(false);expect(r.accounts.msjdatascience.status).toBe('missing-handle');
 expect(Object.values(r.accounts).some(x=>x.status==='blocked')).toBe(true);
});
test('empty array or blank request errors never fabricate confirmed emptiness',()=>{
 const r=classifyCoverage([{inputUrl:'https://www.instagram.com/empty',error:'no_items',requestErrorMessages:[]}],['empty','absent'],3,{logAvailable:true,partialInputs:[],unscopedFailure:false});
 expect(r.accounts.empty.complete).toBe(false);expect(r.accounts.absent.complete).toBe(false);
});
test('only bounded observed results with available clean diagnostics can advance a coverage boundary',()=>{
 const item={inputUrl:'https://www.instagram.com/a',url:'https://www.instagram.com/p/A/',timestamp:'2026-10-13T12:00:00Z'};
 expect(classifyCoverage([item],['a'],3).accounts.a.complete).toBe(false);
 expect(classifyCoverage([item],['a'],1,{logAvailable:true}).accounts.a.complete).toBe(false);
 expect(classifyCoverage([item],['a'],3,{logAvailable:true}).accounts.a.complete).toBe(true);
});
test('account gaps survive retries and cannot be cleared by a later narrow clean window',()=>{
 const p={scope:'s',accounts:{bad:{gapSince:'2026-10-01T00:00:00Z'},good:{coveredFrom:'2026-10-12T00:00:00Z'}}};
 const report={accounts:{bad:{complete:true,status:'observed-window',reasons:[]},good:{complete:true,status:'observed-window',reasons:[]}}};
 const next=advanceAccounts(p,report,{scope:'s',since:'2026-10-12T00:00:00Z',scheduledAt:'2026-10-14T06:00:00Z'});
 expect(next.accounts.bad.gapSince).toBe('2026-10-01T00:00:00Z');expect(next.accounts.bad.coveredFrom).toBeUndefined();
 expect(next.accounts.good.coveredFrom).toBe('2026-10-14T06:00:00Z');expect(coverageFloor(next,'s').coveredFrom).toBe('2026-10-01T00:00:00Z');
 expect(coverageFloor(next,'changed')).toBeNull();
 const recovered=advanceAccounts(next,report,{scope:'s',since:'2026-10-01T00:00:00Z',scheduledAt:'2026-10-15T06:00:00Z'});
 expect(recovered.accounts.bad.gapSince).toBeUndefined();
});
test('unscoped crawl failure and unknown log format fail closed',()=>{
 expect(parseActorDiagnostics('not a complete log').logAvailable).toBe(false);
 expect(parseActorDiagnostics('Final request statistics: {"requestsFailed":1}').unscopedFailure).toBe(true);
});
test('coauthor content is reported as evidence, never as complete input coverage',()=>{
 const r=classifyCoverage([{inputUrl:'https://www.instagram.com/owner',ownerUsername:'owner',url:'https://www.instagram.com/p/ABC/',timestamp:'2026-10-13T00:00:00Z',coauthorProducers:[{username:'collab'}]}],['owner','collab'],3,{logAvailable:true});
 expect(r.accounts.collab.complete).toBe(false);
 expect(r.accounts.collab.relatedContent).toEqual(['https://www.instagram.com/p/ABC/']);
});

describe('sourceHealth', () => {
  const acct = blocked => ({ status: blocked ? 'blocked' : 'observed-window', reasons: blocked ? ['blocked'] : [] });
  const report = (b, total) => ({ accounts: Object.fromEntries(Array.from({ length: total }, (_, i) => [`a${i}`, acct(i < b)])) });
  test('healthy night with a few blocked accounts', () => expect(sourceHealth(report(4, 93))).toEqual({ healthy: true, blocked: 4, requested: 93 }));
  test('mass-blocked night is unhealthy', () => expect(sourceHealth(report(90, 93))).toEqual({ healthy: false, blocked: 90, requested: 93 }));
  test('threshold is inclusive at 25%', () => { expect(sourceHealth(report(1, 4)).healthy).toBe(true); expect(sourceHealth(report(26, 100)).healthy).toBe(false); });
  test('missing report is unhealthy', () => { expect(sourceHealth(null)).toEqual({ healthy: false, blocked: 0, requested: 0 }); expect(sourceHealth({}).healthy).toBe(false); });
  test('ambiguous-empty and cap-reached do not count as blocked', () => expect(sourceHealth({ accounts: { a: { reasons: ['ambiguous-empty'] }, b: { reasons: ['cap-reached'] } } }).blocked).toBe(0));
  test('blocked warning copy', () => expect(blockedWarning({ blocked: 90, requested: 93 }, 4)).toBe('Instagram blocked the scraper for 90 of 93 clubs tonight, so their newest posts may be missing from these images. The next nightly run automatically re-checks at least the last 4 days.'));
});
