import path from 'node:path';
import { digest, readState, writeState } from './state.js';

export function refreshScope(projectDir) {
  return digest({ accounts: readState(path.join(projectDir, 'accounts.json')), clubs: readState(path.join(projectDir, 'clubs.json')) });
}
export function recordRefreshActivity(projectDir, { startedAt, scope, summary, fullCoverage }) {
  if (!fullCoverage || !summary || summary.totalClubs <= 0 || summary.clubsProcessed !== summary.totalClubs || summary.clubsFailed || summary.totalExtractionErrors) return;
  writeState(path.join(projectDir, '.hermes/refresh-activity.json'), { scope, coveredFrom: startedAt });
}
export function latestRefresh(projectDir, checkpoint, scope) {
  const manual = readState(path.join(projectDir, '.hermes/refresh-activity.json'));
  const candidates = [checkpoint, manual].filter(value => value?.scope === scope);
  for (const value of candidates) {
    if (!Number.isFinite(Date.parse(value.coveredFrom))) throw new Error('Invalid refresh activity timestamp');
  }
  return candidates.sort((a, b) => Date.parse(b.coveredFrom) - Date.parse(a.coveredFrom))[0] || null;
}
