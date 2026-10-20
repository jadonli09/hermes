import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { COVERAGE_WARNING } from './coverage.js';
import { runNightly, slotFor } from './nightly.js';
import { digest, readState, writeState, lock } from './state.js';
export const ADDRESS = 'ai.jadonli09@gmail.com';
export const LINK = 'link_6ac224b8c2208191b3e218955d418956';
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const base = root => path.join(root, '.hermes/nightly');
function jobPath(root, id) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(id || '')) throw Error('Invalid job ID');
  return path.join(base(root), id, 'job.json');
}
function manifest(root, id, job) {
  if (!job?.refreshed || !job.images?.length || job.slot.night !== id) throw Error('No healthy prepared images');
  const files = job.images.map((image, i) => {
    const expected = `story-${job.slot.targetDate}-p${i + 1}.png`;
    const real = fs.realpathSync(image.file), parent = fs.realpathSync(path.join(base(root), id));
    if (!real.startsWith(parent + path.sep) || path.basename(real) !== expected) throw Error('Image path mismatch');
    const data = fs.readFileSync(real);
    if (digest(data.toString('base64')) !== image.sha256 || data.length < 24 || data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || data.readUInt32BE(16) !== 1080 || data.readUInt32BE(20) !== 1920) throw Error('Image integrity mismatch');
    return { path: real, filename: expected, mimeType: 'image/png', size: data.length, sha256: sha(data) };
  });
  const incomplete = job.coverageReport?.complete === false;
  const gaps = Object.entries(job.coverageReport?.accounts || {}).filter(([,v])=>!v.complete).map(([name,v])=>({name,status:v.status,reasons:v.reasons || []}));
  const result = { version: 1, jobId: id, targetDate: job.slot.targetDate, cutoff: job.slot.cutoff, from: ADDRESS, to: ADDRESS, linkId: LINK, subject: `Hermes ${job.slot.targetDate} [night-${id}]${incomplete ? ' — refresh incomplete; newer events may be missing' : ''}`, requiredBodyText: incomplete ? COVERAGE_WARNING : '', coverage: {complete:!incomplete,gaps}, files };
  return { ...result, manifestHash: digest(result) };
}
function transaction(root, id, fn) {
  const release = lock(path.join(base(root), 'nightly.lock'));
  try {
    const file = jobPath(root, id), job = readState(file);
    if (!job) throw Error('Unknown job');
    const result = fn(job); writeState(file, job); return result;
  } finally { release(); }
}
export async function prepare(root, { profileEmail, linkId, checkedAt, now = new Date(), clock = () => new Date(), runner = runNightly } = {}) {
  const config = readState(path.join(root, '.hermes/nightly-config.json'), {});
  if (config.enabled !== true || config.deliveryMode !== 'connector' || config.deliveryEnabled !== false) throw Error('Connector execution disabled or configuration invalid');
  if (config.recipient !== ADDRESS || config.fromAddress !== ADDRESS) throw Error('Identity configuration mismatch');
  const age = now.getTime() - Date.parse(checkedAt);
  if (profileEmail !== ADDRESS || linkId !== LINK || !Number.isFinite(age) || age < 0 || age > 300000) throw Error('Fresh successful Gmail profile preflight required before paid work');
  const result = await runner({ projectDir: root, execute: true, deliver: false, coverageMode: config.coverageMode || 'strict', budgetUsd: config.budgetUsd ?? 2, now: clock });
  if (['outside-window', 'empty', 'sent', 'fallback-existing'].includes(result.status)) return result;
  const slot = slotFor(clock());
  if (!slot) throw Error('Delivery window expired');
  return transaction(root, slot.night, job => {
    if (job.emailStatus || job.images?.some(i => i.status)) throw Error('Legacy delivery needs review');
    const output = manifest(root, slot.night, job);
    if (job.connector && job.connector.manifestHash !== output.manifestHash) throw Error('Manifest changed');
    job.status = 'awaiting-delivery';
    return { status: job.connector?.status || job.status, manifest: output, receipt: job.connector?.receipt || null };
  });
}
export function claim(root, id, now = new Date()) {
  return transaction(root, id, job => {
    if (job.connector || job.emailStatus || job.images?.some(i => i.status) || job.status === 'sent') throw Error('Already claimed/submitted; reconcile, never resend');
    if (slotFor(now)?.night !== id || now.getTime() >= Date.parse(job.slot.cutoff)) throw Error('Delivery window expired');
    const output = manifest(root, id, job), token = crypto.randomUUID();
    job.connector = { status: 'sending', token, manifestHash: output.manifestHash, claimedAt: now.toISOString() };
    return { claimToken: token, manifest: output };
  });
}
export function acknowledge(root, id, token, messageId) {
  return transaction(root, id, job => {
    if (!job.connector || job.connector.token !== token || !/^[a-f0-9]+$/i.test(messageId || '')) throw Error('Invalid receipt/claim');
    if (job.connector.receipt && job.connector.receipt.messageId !== messageId) throw Error('Conflicting receipt');
    job.connector.receipt ||= { messageId, acknowledgedAt: new Date().toISOString() };
    if (job.connector.status !== 'verified') job.connector.status = 'submitted'; job.status = 'sent';
    return { status: 'submitted', messageId };
  });
}
export function verify(root, id, token, evidence) {
  return transaction(root, id, job => {
    const c = job.connector;
    if (!c?.receipt || c.token !== token || evidence.messageId !== c.receipt.messageId) throw Error('Receipt mismatch');
    const m = manifest(root, id, job);
    if (m.requiredBodyText && !String(evidence.bodyText || '').includes(m.requiredBodyText)) throw Error('Required coverage warning missing from received body');
    if (m.manifestHash !== c.manifestHash || evidence.from !== ADDRESS || evidence.to !== ADDRESS || evidence.subject !== m.subject || !evidence.labels?.includes('SENT') || !evidence.labels?.includes('INBOX')) throw Error('Message verification mismatch');
    if (JSON.stringify(evidence.attachments) !== JSON.stringify(m.files.map(({filename,mimeType,size,sha256}) => ({filename,mimeType,size,sha256})))) throw Error('Attachment verification mismatch');
    c.status = 'verified'; c.verifiedAt = new Date().toISOString();
    return { status: 'verified', messageId: c.receipt.messageId };
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const [command, ...args] = process.argv.slice(2);
  const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  try {
    let result;
    if (command === 'prepare') result = await prepare(root, { profileEmail: option('--profile-email'), linkId: option('--link-id'), checkedAt: option('--checked-at') });
    else if (command === 'claim') result = claim(root, option('--job'));
    else if (command === 'acknowledge') result = acknowledge(root, option('--job'), option('--claim'), option('--message-id'));
    else if (command === 'verify') result = verify(root, option('--job'), option('--claim'), JSON.parse(fs.readFileSync(option('--evidence'), 'utf8')));
    else if (command === 'status') { const id = option('--job'), job = readState(jobPath(root, id)); result = { job, manifest: job?.images?.length ? manifest(root, id, job) : null }; }
    else throw Error('Use prepare, claim, acknowledge, verify, or status');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
