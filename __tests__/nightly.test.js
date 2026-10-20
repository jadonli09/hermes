import { jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { slotFor, fetchPlan, pacificInstant, runNightly } from '../automation/nightly.js';
import { readState, writeState } from '../automation/state.js';
import { recordRefreshActivity, latestRefresh, refreshScope } from '../automation/refresh-activity.js';

const sunday = new Date('2026-10-19T06:00:00Z'); // Sunday 23:00 PDT
let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-nightly-test-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const healthy = [{ t: 'summary', summary: { totalClubs: 1, clubsProcessed: 1, clubsFailed: 0, totalExtractionErrors: 0 } }];
function imageChild(pages = 2) {
  return jest.fn(async (script, args) => {
    if (script === 'main.js') return healthy;
    const date = args.find(a => a.startsWith('--date=')).slice(7);
    const out = args.find(a => a.startsWith('--out=')).slice(6);
    const files = Array.from({ length: pages }, (_, i) => `story-${date}-p${i + 1}.png`);
    for (const file of files) {
      const png = Buffer.alloc(24); Buffer.from('89504e470d0a1a0a', 'hex').copy(png); png.writeUInt32BE(1080, 16); png.writeUInt32BE(1920, 20); fs.writeFileSync(path.join(out, file), png);
    }
    return [{ t: 'story:done', date, pages, files }];
  });
}
const base = () => ({ projectDir: dir, now: () => sunday, execute: true });

test('Sunday through Thursday produce Monday through Friday, never Friday/Saturday nights', () => {
  expect(slotFor(sunday).targetDate).toBe('2026-10-19');
  expect(slotFor(new Date('2026-10-20T06:00:00Z')).targetDate).toBe('2026-10-20');
  expect(slotFor(new Date('2026-10-23T06:00:00Z')).targetDate).toBe('2026-10-23');
  expect(slotFor(new Date('2026-10-24T06:00:00Z'))).toBeNull();
  expect(slotFor(new Date('2026-10-25T06:00:00Z'))).toBeNull();
});
test('DST uses Pacific calendar dates; morning catch-up stops at 06:00', () => {
  expect(pacificInstant('2026-11-01', 23)).toBe('2026-11-02T07:00:00.000Z');
  expect(pacificInstant('2026-03-08', 23)).toBe('2026-03-09T06:00:00.000Z');
  expect(slotFor(new Date('2026-10-19T12:59:00Z')).targetDate).toBe('2026-10-19');
  expect(slotFor(new Date('2026-10-19T13:00:00Z'))).toBeNull();
});
describe('rolling fetch window', () => {
  const monday = slotFor(new Date('2026-10-20T05:00:00Z')); // night 2026-10-19
  test('normal night re-scans a rolling 4-day window', () =>
    expect(fetchPlan(monday, { scope: 'a', coveredFrom: '2026-10-19T04:00:00.000Z' }, 'a'))
      .toMatchObject({ since: '2026-10-16T07:00:00.000Z', limit: 8, catchUp: false, reason: 'rolling' }));
  test('after a blocked or missed stretch the window widens back to the last healthy run', () =>
    expect(fetchPlan(monday, { scope: 'a', coveredFrom: '2026-10-14T04:00:00.000Z' }, 'a'))
      .toMatchObject({ since: '2026-10-14T04:00:00.000Z', limit: 14, catchUp: true, reason: 'extended-after-gap' }));
  test('never looks back more than 11 days', () =>
    expect(fetchPlan(monday, { scope: 'a', coveredFrom: '2026-10-01T04:00:00.000Z' }, 'a'))
      .toMatchObject({ since: '2026-10-09T07:00:00.000Z', limit: 22, reason: 'max-lookback' }));
  test('no history uses the 11-day window', () =>
    expect(fetchPlan(monday, null, 'a')).toMatchObject({ since: '2026-10-09T07:00:00.000Z', limit: 22, reason: 'no-trusted-history' }));
  test('a scope change is treated as no history', () =>
    expect(fetchPlan(monday, { scope: 'a', coveredFrom: '2026-10-19T04:00:00.000Z' }, 'b')).toMatchObject({ reason: 'no-trusted-history', limit: 22 }));
  test('Sunday after skipped Fri/Sat still overlaps Thursday', () =>
    expect(fetchPlan(slotFor(new Date('2026-10-19T05:00:00Z')), { scope: 'a', coveredFrom: '2026-10-16T04:00:00.000Z' }, 'a'))
      .toMatchObject({ since: '2026-10-15T07:00:00.000Z', limit: 8, reason: 'rolling' }));
});
test('default planning performs no writes, paid work, or delivery', async () => {
  const child = jest.fn(), sender = jest.fn();
  const result = await runNightly({ ...base(), execute: false, child, sender });
  expect(result.status).toBe('plan-only'); expect(fs.readdirSync(dir)).toHaveLength(0); expect(child).not.toHaveBeenCalled(); expect(sender).not.toHaveBeenCalled();
});
test('prepares only fresh images in order; rerun skips completed refresh/render', async () => {
  const child = imageChild(12), sender = jest.fn();
  const result = await runNightly({ ...base(), child, sender });
  expect(result).toEqual({ status: 'prepared', pages: 12 });
  await runNightly({ ...base(), child, sender }); expect(child).toHaveBeenCalledTimes(2); expect(sender).not.toHaveBeenCalled();
  const job = readState(path.join(dir, '.hermes/nightly/2026-10-18/job.json'));
  expect(job.images[9].file).toMatch(/p10.png$/);
  expect(child.mock.calls[0][2].env.RESUME).toBe('false');
});
test('empty days send nothing; failed refresh does not render or checkpoint', async () => {
  const sender = jest.fn();
  expect(await runNightly({ ...base(), child: imageChild(0), sender })).toEqual({ status: 'empty', pages: 0 });
  expect(sender).not.toHaveBeenCalled();
  fs.rmSync(path.join(dir, '.hermes'), { recursive: true });
  const child = jest.fn().mockResolvedValue([{ t: 'summary', summary: { ...healthy[0].summary, totalExtractionErrors: 1 } }]);
  await expect(runNightly({ ...base(), child })).rejects.toThrow(/health/);
  expect(child).toHaveBeenCalledTimes(1); expect(readState(path.join(dir, '.hermes/nightly/checkpoint.json'))).toBeNull();
});
test('unknown email outcome is never automatically retried', async () => {
  const sender = jest.fn().mockRejectedValueOnce(new Error('uncertain'));
  const options = { ...base(), child: imageChild(2), sender, deliver: true, recipient: 'ai.jadonli09@gmail.com', fromAddress: 'ai.jadonli09@gmail.com' };
  await expect(runNightly(options)).rejects.toThrow('uncertain');
  await expect(runNightly(options)).rejects.toThrow(/Uncertain prior/);
  expect(sender).toHaveBeenCalledTimes(1);
});
test('overlap lock and recipient validation prevent paid work', async () => {
  const child = imageChild();
  await expect(runNightly({ ...base(), child, deliver: true })).rejects.toThrow(/recipient/);
  writeState(path.join(dir, '.hermes/nightly/nightly.lock'), { pid: 123 });
  await expect(runNightly({ ...base(), child })).rejects.toThrow(/Already running/); expect(child).not.toHaveBeenCalled();
});

test('old weekly audit marker never triggers backfill while refreshes remain active', () => {
  const last = { scope: 'a', coveredFrom: pacificInstant('2026-10-15', 23), auditAt: pacificInstant('2026-01-01', 23) };
  expect(fetchPlan(slotFor(sunday), last, 'a')).toMatchObject({ limit: 8, catchUp: false, reason: 'rolling' });
});
test('successful full manual activity counts; failed and partial refreshes cannot advance activity', () => {
  const scope = refreshScope(dir);
  const old = { scope, coveredFrom: pacificInstant('2026-10-01', 23) };
  recordRefreshActivity(dir, { startedAt: pacificInstant('2026-10-15', 23), scope, summary: healthy[0].summary, fullCoverage: true });
  const current = latestRefresh(dir, old, scope);
  expect(fetchPlan(slotFor(sunday), current, scope)).toMatchObject({ limit: 8, catchUp: false });
  recordRefreshActivity(dir, { startedAt: pacificInstant('2026-10-16', 23), scope, summary: healthy[0].summary, fullCoverage: false });
  recordRefreshActivity(dir, { startedAt: pacificInstant('2026-10-17', 23), scope, summary: { ...healthy[0].summary, totalExtractionErrors: 1 }, fullCoverage: true });
  expect(latestRefresh(dir, old, scope)).toEqual(current);
  expect(latestRefresh(dir, old, 'changed-accounts')).toBeNull();
});

test('manual activity after 23:00 does not invalidate the current nightly slot', () => {
  const slot = slotFor(sunday);
  const plan = fetchPlan(slot, { scope: 'a', coveredFrom: '2026-10-19T06:10:00Z' }, 'a');
  expect(plan).toMatchObject({ limit: 8, catchUp: false, reason: 'rolling' });
  expect(Date.parse(plan.since)).toBeLessThan(Date.parse(slot.scheduledAt));
});

 test('all pages are emailed together once with the intended sender and event date', async () => {
  const sender = jest.fn();
  const options = { ...base(), child: imageChild(3), sender, deliver: true, recipient: 'ai.jadonli09@gmail.com', fromAddress: 'ai.jadonli09@gmail.com' };
  expect(await runNightly(options)).toEqual({ status: 'sent', pages: 3 });
  await runNightly(options);
  expect(sender).toHaveBeenCalledTimes(1);
  expect(sender.mock.calls[0][0]).toHaveLength(3);
  expect(sender.mock.calls[0][2]).toEqual({ fromAddress: 'ai.jadonli09@gmail.com', targetDate: '2026-10-19' });
});

test('best effort prepares partial refresh without advancing unknown accounts or global checkpoint',async()=>{
 const child=imageChild(1), original=child.getMockImplementation();
 child.mockImplementation(async(script,args,opts)=>script==='main.js' ? [...healthy,{t:'coverage',report:{version:2,complete:false,warning:'Refresh incomplete; newer events may be missing.',accounts:{good:{complete:true,status:'observed-window',reasons:[]},bad:{complete:false,status:'blocked',reasons:['blocked']}}}}] : original(script,args,opts));
 const result=await runNightly({...base(),coverageMode:'best-effort',child});
 expect(result.status).toBe('prepared');
 expect(readState(path.join(dir,'.hermes/nightly/checkpoint.json'))).toBeNull();
 const accounts=readState(path.join(dir,'.hermes/nightly/account-coverage.json'));
 expect(accounts?.accounts.good.coveredFrom).toBe('2026-10-19T04:00:00.000Z');
 expect(accounts?.accounts.bad.coveredFrom).toBeUndefined();
 expect(accounts?.accounts.bad.gapSince).toBe('2026-10-08T07:00:00.000Z');
 const job=readState(path.join(dir,'.hermes/nightly/2026-10-18/job.json'));
 expect(job.coverageReport.complete).toBe(false);
});
test('previously delivered fallback prevents any paid prepare or second email',async()=>{
 writeState(path.join(dir,'.hermes/fallback/2026-10-18.json'),{status:'verified',messageId:'abc123'});
 const child=jest.fn();
 expect(await runNightly({...base(),coverageMode:'best-effort',child})).toMatchObject({status:'fallback-existing'});
 expect(child).not.toHaveBeenCalled();
});
test('old failed jobs cannot widen a new normal bootstrap or count as activity',async()=>{
 const scope=refreshScope(dir);
 writeState(path.join(dir,'.hermes/nightly/2026-10-01/job.json'),{scope,plan:{since:'2026-09-21T07:00:00Z'},status:'pending'});
 const r=await runNightly({...base(),execute:false,coverageMode:'best-effort'});
 expect(r.plan.since).toBe(pacificInstant('2026-10-08')); expect(r.plan.limit).toBe(22);
});
test('strict rejects an incomplete coverage report even with successful pipeline summary',async()=>{
 const child=jest.fn().mockResolvedValue([...healthy,{t:'coverage',report:{version:2,complete:false,accounts:{a:{complete:false,status:'blocked'}}}}]);
 await expect(runNightly({...base(),child})).rejects.toThrow(/Strict coverage/);
 expect(readState(path.join(dir,'.hermes/nightly/checkpoint.json'))).toBeNull();
});
test('authorized 21:00 Pacific schedule refuses early work and keeps the next-day target through midnight',()=>{
 expect(slotFor(new Date('2026-10-15T03:59:59Z'))).toBeNull();
 expect(slotFor(new Date('2026-10-15T04:00:00Z'))).toEqual({night:'2026-10-14',targetDate:'2026-10-15',scheduledAt:'2026-10-15T04:00:00.000Z',cutoff:'2026-10-15T13:00:00.000Z'});
 expect(slotFor(new Date('2026-10-15T07:30:00Z')).targetDate).toBe('2026-10-15');
});
