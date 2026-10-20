import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function readState(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export function writeState(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
// Fail closed after an unclean shutdown. Reclaim only after checking no old
// pipeline/actor is active; PID reuse makes automatic stale-lock removal unsafe.
export function lock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`Already running or recovery required: ${file}`); throw error; }
  return () => fs.unlinkSync(file);
}
export function canonicalPostUrl(value) {
  const match = String(value || '').match(/^https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|tv)\/([^/?#]+)/i);
  return match ? `https://www.instagram.com/p/${match[1]}/` : String(value || '').trim();
}
