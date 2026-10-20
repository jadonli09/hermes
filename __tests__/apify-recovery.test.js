import { jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runActor } from '../scrapers/apify-client.js';
import { readState } from '../automation/state.js';
let dir, opts;
const response = (body, headers = {}) => new Response(JSON.stringify(body), { headers });
const started = () => response({ data: { id: 'run1', defaultDatasetId: 'dataset1', status: 'RUNNING' } });
const success = (extra = {}) => response({ data: { id: 'run1', status: 'SUCCEEDED', ...extra } });
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-apify-test-'));
  opts = { token: 'fake', actorId: 'apify/instagram-post-scraper', input: { username: ['club'] }, maxTotalChargeUsd: 2, statePath: path.join(dir, 'run.json'), ledgerPath: path.join(dir, 'ledger.json') };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
test('starts once, persists ID, paginates same dataset, reuses cache without network', async () => {
  const fetchFn = jest.fn().mockResolvedValueOnce(started()).mockResolvedValueOnce(success())
    .mockResolvedValueOnce(response([{ url: 'A' }], { 'x-apify-pagination-total': '2' }))
    .mockResolvedValueOnce(response([{ url: 'B' }], { 'x-apify-pagination-total': '2' }));
  expect(await runActor({ ...opts, fetchFn })).toHaveLength(2);
  expect(await runActor({ ...opts, fetchFn })).toHaveLength(2);
  expect(fetchFn).toHaveBeenCalledTimes(4);
  expect(fetchFn.mock.calls.filter(([, o]) => o.method === 'POST')).toHaveLength(1);
  expect(fetchFn.mock.calls[3][0]).toContain('offset=1');
  expect(fetchFn.mock.calls[0][0]).toContain('maxTotalChargeUsd=2');
  expect(fetchFn.mock.calls[0][0]).not.toContain('fake');
});
test('lost POST response blocks retry and another job instead of spending again', async () => {
  const fetchFn = jest.fn().mockRejectedValue(new Error('lost response'));
  await expect(runActor({ ...opts, fetchFn })).rejects.toThrow('lost response');
  await expect(runActor({ ...opts, fetchFn })).rejects.toThrow(/Ambiguous/);
  await expect(runActor({ ...opts, statePath: path.join(dir, 'tomorrow.json'), fetchFn })).rejects.toThrow(/Unresolved/);
  expect(fetchFn).toHaveBeenCalledTimes(1);
});
test('poll timeout resumes existing ID, never starts replacement', async () => {
  const fetchFn = jest.fn().mockResolvedValueOnce(started()).mockResolvedValueOnce(response({ data: { status: 'RUNNING' } }));
  await expect(runActor({ ...opts, fetchFn, maxPollMs: 0 })).rejects.toThrow(/resume saved run/);
  expect(readState(opts.statePath).runId).toBe('run1');
  fetchFn.mockResolvedValueOnce(success()).mockResolvedValueOnce(response([]));
  await runActor({ ...opts, fetchFn });
  expect(fetchFn.mock.calls.filter(([, o]) => o.method === 'POST')).toHaveLength(1);
});
test('terminal failure and budget exhaustion refuse partial results', async () => {
  const fetchFn = jest.fn().mockResolvedValueOnce(started()).mockResolvedValueOnce(success({ statusMessage: 'max total charge reached' }));
  await expect(runActor({ ...opts, fetchFn })).rejects.toThrow(/budget reached/);
  fetchFn.mockResolvedValueOnce(response({ data: { status: 'FAILED' } }));
  await expect(runActor({ ...opts, fetchFn })).rejects.toThrow(/ended FAILED/);
  expect(fetchFn.mock.calls.filter(([, o]) => o.method === 'POST')).toHaveLength(1);
});
test('changed input or invalid budget cannot create another paid run', async () => {
  const fetchFn = jest.fn().mockRejectedValue(new Error('lost'));
  await expect(runActor({ ...opts, fetchFn })).rejects.toThrow();
  await expect(runActor({ ...opts, input: {}, fetchFn })).rejects.toThrow(/input changed/);
  await expect(runActor({ ...opts, maxTotalChargeUsd: NaN, fetchFn })).rejects.toThrow(/budget/);
  expect(fetchFn).toHaveBeenCalledTimes(1);
});
test('dataset read failure recovers without a new POST', async () => {
  const fetchFn = jest.fn().mockResolvedValueOnce(started()).mockResolvedValueOnce(success())
    .mockResolvedValueOnce(new Response('', { status: 403 }));
  await expect(runActor({ ...opts, fetchFn })).rejects.toThrow('403');
  fetchFn.mockResolvedValueOnce(success()).mockResolvedValueOnce(response([{ id: 1 }]));
  expect(await runActor({ ...opts, fetchFn })).toEqual([{ id: 1 }]);
  expect(fetchFn.mock.calls.filter(([, o]) => o.method === 'POST')).toHaveLength(1);
});
test('best effort saves existing actor log diagnostics and reuses them with cached rows',async()=>{
 process.env.HERMES_COVERAGE_MODE='best-effort';
 try {
  const fetchFn=jest.fn().mockResolvedValueOnce(started()).mockResolvedValueOnce(success()).mockResolvedValueOnce(response([{url:'A'}])).mockResolvedValueOnce(new Response('WARN posts feed pagination request failed after retries {"origin":"https://www.instagram.com/club"}\nFinal request statistics: {"requestsFailed":1}'));
  let diagnostics;
  await runActor({...opts,fetchFn,onDiagnostics:d=>{diagnostics=d;}});
  expect(diagnostics).toMatchObject({logAvailable:true,partialInputs:['club'],unscopedFailure:false});
  await runActor({...opts,fetchFn});expect(fetchFn.mock.calls.filter(([,o])=>o.method==='POST')).toHaveLength(1);
  expect(readState(opts.statePath).diagnostics.partialInputs).toEqual(['club']);
 }finally{delete process.env.HERMES_COVERAGE_MODE;}
});

describe('saved request order recovery',()=>{
 const original={username:['alpha','beta'],resultsLimit:16,onlyPostsNewerThan:'2026-10-03T07:00:00Z',skipPinnedPosts:true};
 async function failedRead(){
  const fetchFn=jest.fn().mockResolvedValueOnce(started()).mockResolvedValueOnce(success()).mockResolvedValueOnce(new Response('',{status:403}));
  await expect(runActor({...opts,input:original,maxItems:32,fetchFn})).rejects.toThrow('403');
  return fetchFn;
 }
 test('same membership in random order reuses original run and preserves original request key/input',async()=>{
  const fetchFn=await failedRead();const before=readState(opts.statePath);
  fetchFn.mockResolvedValueOnce(success()).mockResolvedValueOnce(response([{id:1}]));
  expect(await runActor({...opts,input:{...original,username:['beta','alpha']},maxItems:32,fetchFn})).toEqual([{id:1}]);
  const after=readState(opts.statePath);expect(after.requestKey).toBe(before.requestKey);expect(after.input).toEqual(original);
  expect(fetchFn.mock.calls.filter(([,o])=>o.method==='POST')).toHaveLength(1);
  expect(fetchFn.mock.calls[3][0]).toContain('/actor-runs/run1');expect(fetchFn.mock.calls[4][0]).toContain('/datasets/dataset1/');
 });
 test.each([
  ['membership',{input:{...original,username:['beta','gamma']}}],
  ['duplicates',{input:{...original,username:['alpha','alpha']}}],
  ['case',{input:{...original,username:['beta','ALPHA']}}],
  ['whitespace',{input:{...original,username:['beta','alpha ']}}],
  ['limit',{input:{...original,username:['beta','alpha'],resultsLimit:17}}],
  ['date',{input:{...original,username:['beta','alpha'],onlyPostsNewerThan:'2026-10-04T07:00:00Z'}}],
  ['pinned',{input:{...original,username:['beta','alpha'],skipPinnedPosts:false}}],
  ['extra field',{input:{...original,username:['beta','alpha'],extra:true}}],
  ['budget',{maxTotalChargeUsd:1}],['maxItems',{maxItems:33}],['actor',{actorId:'other/actor'}]
 ])('changed %s fails before any network request',async(_,change)=>{
  const fetchFn=await failedRead();const before=fs.readFileSync(opts.statePath);
  await expect(runActor({...opts,input:{...original,username:['beta','alpha']},maxItems:32,...change,fetchFn})).rejects.toThrow(/input changed/);
  expect(fetchFn).toHaveBeenCalledTimes(3);expect(fs.readFileSync(opts.statePath)).toEqual(before);
 });
 test('unknown start cannot use order recovery',async()=>{
  const fetchFn=jest.fn().mockRejectedValue(new Error('lost'));
  await expect(runActor({...opts,input:original,maxItems:32,fetchFn})).rejects.toThrow();
  await expect(runActor({...opts,input:{...original,username:['beta','alpha']},maxItems:32,fetchFn})).rejects.toThrow(/input changed/);
  expect(fetchFn).toHaveBeenCalledTimes(1);
 });
});

describe('dataset pagination integrity',()=>{
 const page=(rows,total,extra={})=>response(rows,{...(total===null?{}:{'x-apify-pagination-total':String(total)}),...extra});
 test('a transient inconsistent total retries same offset, appends once, starts once',async()=>{
  const fetchFn=jest.fn().mockResolvedValueOnce(started()).mockResolvedValueOnce(success())
   .mockResolvedValueOnce(page([{id:1}],0)).mockResolvedValueOnce(page([{id:1}],1,{'x-apify-pagination-count':'1','x-apify-pagination-offset':'0'}));
  const sleep=jest.fn();expect(await runActor({...opts,fetchFn,sleep})).toEqual([{id:1}]);
  expect(fetchFn.mock.calls[2][0]).toBe(fetchFn.mock.calls[3][0]);expect(fetchFn.mock.calls.filter(([,o])=>o.method==='POST')).toHaveLength(1);expect(sleep).toHaveBeenCalledTimes(1);
 });
 test.each([
  ['negative',()=>page([{}],-1)],['fractional',()=>page([{}],1.5)],['blank',()=>page([{}],'')],
  ['too small',()=>page([{}],0)],['wrong count',()=>page([{}],1,{'x-apify-pagination-count':'2'})],
  ['wrong offset',()=>page([{}],1,{'x-apify-pagination-offset':'1'})],['no progress',()=>page([],1)]
 ])('persistent %s fails closed after bounded GETs with no cached partial data',async(_,make)=>{
  const fetchFn=jest.fn().mockResolvedValueOnce(started()).mockResolvedValueOnce(success()).mockImplementation(async()=>make());
  await expect(runActor({...opts,fetchFn,sleep:async()=>{}})).rejects.toThrow(/after 3 reads.*offset=0/);
  expect(fetchFn).toHaveBeenCalledTimes(5);expect(readState(opts.statePath).items).toBeUndefined();expect(readState(opts.ledgerPath).statePath).toBe(opts.statePath);
 });
 test('changing totals between pages cannot truncate a completed dataset',async()=>{
  const fetchFn=jest.fn().mockResolvedValueOnce(started()).mockResolvedValueOnce(success()).mockResolvedValueOnce(page([{id:1}],2)).mockImplementation(async()=>page([],1));
  await expect(runActor({...opts,fetchFn,sleep:async()=>{}})).rejects.toThrow(/expectedTotal=2/);expect(readState(opts.statePath).items).toBeUndefined();
 });
 test('known empty dataset and absent-header small dataset remain supported',async()=>{
  const fetchFn=jest.fn().mockResolvedValueOnce(started()).mockResolvedValueOnce(success()).mockResolvedValueOnce(page([],0));
  expect(await runActor({...opts,fetchFn})).toEqual([]);
 });
 test('absent-header full page continues to the next offset',async()=>{
  const fetchFn=jest.fn().mockResolvedValueOnce(started()).mockResolvedValueOnce(success()).mockResolvedValueOnce(page(Array.from({length:1000},(_,id)=>({id})),null)).mockResolvedValueOnce(page([{id:1000}],null));
  expect(await runActor({...opts,fetchFn})).toHaveLength(1001);expect(fetchFn.mock.calls[3][0]).toContain('offset=1000');
 });
});
test('concurrent actor calls fail at the ledger lock before a second POST',async()=>{
 let release; const gate=new Promise(r=>{release=r;});
 const fetchFn=jest.fn().mockImplementationOnce(()=>gate).mockResolvedValueOnce(success()).mockResolvedValueOnce(response([]));
 const running=runActor({...opts,fetchFn});
 await expect(runActor({...opts,fetchFn})).rejects.toThrow(/Already running/);
 release(started());await running;expect(fetchFn.mock.calls.filter(([,o])=>o.method==='POST')).toHaveLength(1);
});
test('stale lock is never removed automatically',async()=>{
 fs.writeFileSync(opts.ledgerPath+'.lock','{"pid":999999999}');const fetchFn=jest.fn();
 await expect(runActor({...opts,fetchFn})).rejects.toThrow(/Already running/);expect(fetchFn).not.toHaveBeenCalled();expect(fs.existsSync(opts.ledgerPath+'.lock')).toBe(true);
});
test('damaged checkpoint JSON fails before network',async()=>{
 fs.writeFileSync(opts.statePath,'{');const fetchFn=jest.fn();await expect(runActor({...opts,fetchFn})).rejects.toThrow();expect(fetchFn).not.toHaveBeenCalled();
});

test('scheduled acknowledged cache is retained and reused, never treated as a fresh manual run',async()=>{
 const fetchFn=jest.fn().mockResolvedValueOnce(started()).mockResolvedValueOnce(success()).mockResolvedValueOnce(response([{id:1}]));
 await runActor({...opts,fetchFn});const state=readState(opts.statePath);state.acknowledged=true;fs.writeFileSync(opts.statePath,JSON.stringify(state));
 const previous=process.env.HERMES_APIFY_STATE;process.env.HERMES_APIFY_STATE=opts.statePath;
 try { expect(await runActor({...opts,fetchFn})).toEqual([{id:1}]);expect(fetchFn).toHaveBeenCalledTimes(3); }
 finally {if(previous===undefined)delete process.env.HERMES_APIFY_STATE;else process.env.HERMES_APIFY_STATE=previous;}
});
test('new manual run after acknowledged completion still requires its own durable intent',async()=>{
 const previous=process.env.HERMES_APIFY_STATE;delete process.env.HERMES_APIFY_STATE;
 try {
  const fetchFn=jest.fn().mockResolvedValueOnce(started()).mockResolvedValueOnce(success()).mockResolvedValueOnce(response([]));
  await runActor({...opts,fetchFn});const state=readState(opts.statePath);state.acknowledged=true;fs.writeFileSync(opts.statePath,JSON.stringify(state));
  fetchFn.mockResolvedValueOnce(started()).mockResolvedValueOnce(success()).mockResolvedValueOnce(response([]));
  await runActor({...opts,fetchFn});expect(fetchFn.mock.calls.filter(([,o])=>o.method==='POST')).toHaveLength(2);expect(readState(opts.statePath).acknowledged).toBeUndefined();
 }finally{if(previous!==undefined)process.env.HERMES_APIFY_STATE=previous;}
});
