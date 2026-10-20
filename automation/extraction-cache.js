import path from 'node:path';
import { digest, readState, writeState, canonicalPostUrl } from './state.js';

// Version the schema/prompt identity. Signed CDN query changes should not cause
// repeated extraction. Existing sheet URLs remain authoritative and are skipped
// before this cache is considered, preserving reviewed/manual sheet edits.
export async function cachedExtraction(post, extract, { directory = path.resolve('.hermes/extractions'), models = {} } = {}) {
  const images = (post.imageUrls || []).map(url => { try { const u = new URL(url); return `${u.host}${u.pathname}`; } catch { return url; } });
  const key = digest({ v: 2, url: canonicalPostUrl(post.postUrl), account: post.accountName, date: post.postDate, caption: post.caption, images, models });
  const file = path.join(directory, `${key}.json`);
  const cached = readState(file);
  if (cached) return { result: cached.result, cached: true };
  const result = await extract();
  const rows = Array.isArray(result) ? result : [result];
  if (rows.length && rows.every(row => row && !row.error)) writeState(file, { result });
  return { result, cached: false };
}
