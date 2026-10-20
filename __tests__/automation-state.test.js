import { jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readState, writeState, lock, canonicalPostUrl, digest } from '../automation/state.js';
import { cachedExtraction } from '../automation/extraction-cache.js';
let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-test-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
test('state survives reload, corrupt checkpoints fail closed, locks exclude overlap', () => {
  const file = path.join(dir, 'state.json');
  writeState(file, { done: true }); expect(readState(file)).toEqual({ done: true });
  const release = lock(file + '.lock'); expect(() => lock(file + '.lock')).toThrow(/Already running/); release();
  fs.writeFileSync(file, '{'); expect(() => readState(file)).toThrow();
});
test('canonical URLs remove tracking and preserve shortcode case', () => {
  expect(canonicalPostUrl('https://instagram.com/reel/AbC/?igsh=secret')).toBe('https://www.instagram.com/p/AbC/');
});
test('profile-prefixed post links from the Playwright scraper canonicalize to the same post', () => {
  expect(canonicalPostUrl('https://www.instagram.com/msjfilm/p/Der6OdBPARq/')).toBe('https://www.instagram.com/p/Der6OdBPARq/');
  expect(canonicalPostUrl('https://www.instagram.com/msj.redcross/reel/DeqRPxNN5B1/?img_index=1')).toBe('https://www.instagram.com/p/DeqRPxNN5B1/');
});
test('cached extraction survives retry and signed-image URL changes', async () => {
  const post = { postUrl: 'https://instagram.com/p/A/', caption: 'Meeting', imageUrls: ['https://cdn.test/a.jpg?token=1'] };
  const extract = jest.fn().mockResolvedValue({ event_date: '2026-10-14' });
  await cachedExtraction(post, extract, { directory: dir });
  const r = await cachedExtraction({ ...post, imageUrls: ['https://cdn.test/a.jpg?token=2'] }, extract, { directory: dir });
  expect(r.cached).toBe(true); expect(extract).toHaveBeenCalledTimes(1);
  await cachedExtraction({ ...post, caption: 'Changed' }, extract, { directory: dir });
  expect(extract).toHaveBeenCalledTimes(2);
});
test('failed extraction is not cached; empty-event successful extraction is', async () => {
  const fn = jest.fn().mockResolvedValueOnce({ error: 'network' }).mockResolvedValue({ event_date: null });
  await cachedExtraction({}, fn, { directory: dir }); await cachedExtraction({}, fn, { directory: dir }); await cachedExtraction({}, fn, { directory: dir });
  expect(fn).toHaveBeenCalledTimes(2);
});

test('ambiguous Sheets append records intent and refuses a second mutation', async () => {
  const { appendOnce } = await import('../automation/sheets-append.js');
  const append = jest.fn().mockRejectedValue(new Error('response lost'));
  const file = path.join(dir, 'append.json');
  await expect(appendOnce(append, [['event']], file)).rejects.toThrow('response lost');
  await expect(appendOnce(append, [['event']], file)).rejects.toThrow(/Uncertain prior/);
  expect(append).toHaveBeenCalledTimes(1);
});

test('old inferred-time cache is not reused by v2 and remains untouched', async()=>{
 const post={postUrl:'https://www.instagram.com/p/OLD/',accountName:'club',postDate:'2026-10-16',caption:'Meeting Friday',imageUrls:[]};
 const key=digest({v:1,url:canonicalPostUrl(post.postUrl),account:post.accountName,date:post.postDate,caption:post.caption,images:[],models:{}});
 const old=path.join(dir,key+'.json');writeState(old,{result:{event_time:'Lunch'}});const bytes=fs.readFileSync(old);
 const extract=jest.fn().mockResolvedValue({event_date:'2026-10-16',event_time:null});
 const first=await cachedExtraction(post,extract,{directory:dir});
 expect(first.cached).toBe(false);expect(first.result.event_time).toBeNull();
 expect((await cachedExtraction(post,extract,{directory:dir})).cached).toBe(true);
 expect(extract).toHaveBeenCalledTimes(1);expect(fs.readFileSync(old)).toEqual(bytes);
});
