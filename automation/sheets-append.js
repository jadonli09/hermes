import fs from 'node:fs';
import path from 'node:path';
import { readState, writeState, digest } from './state.js';
export const appendCheckpoint = () => path.resolve('.hermes/sheets-pending.json');
export function assertNoPendingAppend(file = appendCheckpoint()) {
  if (readState(file)) throw new Error(`Uncertain prior Sheets append; reconcile sheet rows with ${file} before retrying`);
}
export async function appendOnce(append, rows, file = appendCheckpoint()) {
  assertNoPendingAppend(file);
  writeState(file, { at: new Date().toISOString(), key: digest(rows), rows });
  // append is not idempotent. No network retries, even if the response is lost.
  const response = await append();
  fs.unlinkSync(file);
  return response;
}
