// The web layer can edit operational knobs and the account list. It cannot read
// or write secrets - not because the UI is careless today, but because an
// allowlist is the only version of this that stays safe once the dashboard is
// deployed somewhere with a URL.
import fs from 'fs';
import path from 'path';

export const EDITABLE_ENV = {
  START_DAYS_AGO:       { type: 'int',   min: 0,    max: 365 },
  MAX_CLUBS_TO_PROCESS: { type: 'int',   min: 1,    max: 1000 },
  MAX_CAROUSEL_IMAGES:  { type: 'int',   min: 1,    max: 20 },
  APIFY_RESULTS_LIMIT:  { type: 'int',   min: 1,    max: 200 },
  APIFY_MAX_CHARGE_USD: { type: 'float', min: 0.01, max: 100 }
};

const REPORTED_SECRETS = ['APIFY_TOKEN', 'ANTHROPIC_API_KEY', 'GOOGLE_SPREADSHEET_ID'];
const HANDLE = /^[A-Za-z0-9._]{1,30}$/;

const envPath = (dir) => path.join(dir, '.env');
const accountsPath = (dir) => path.join(dir, 'accounts.json');

function readEnvText(dir) {
  return fs.existsSync(envPath(dir)) ? fs.readFileSync(envPath(dir), 'utf-8') : '';
}

function parseEnv(text) {
  const values = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (match) values[match[1]] = match[2].trim();
  }
  return values;
}

export function updateEnvText(text, updates) {
  let result = text;

  for (const [key, value] of Object.entries(updates)) {
    const assignment = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');

    if (assignment.test(result)) {
      result = result.replace(assignment, `${key}=${value}`);
    } else {
      // A commented-out key stays commented: rewriting it in place would leave
      // the file reading as "disabled" while the value was actually live.
      if (result !== '' && !result.endsWith('\n')) result += '\n';
      result += `${key}=${value}\n`;
    }
  }

  return result;
}

function writeAtomic(file, contents) {
  // Same directory, so the rename is atomic on the same filesystem. A crash
  // mid-write leaves the original intact rather than a truncated accounts.json.
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, contents);
  fs.renameSync(temp, file);
}

function validateAccounts(accounts) {
  if (!accounts || typeof accounts !== 'object' || !accounts.categories) {
    throw new Error('accounts must have a "categories" object');
  }

  const seen = new Map();

  for (const [name, category] of Object.entries(accounts.categories)) {
    if (!category || !Array.isArray(category.accounts)) {
      throw new Error(`Category "${name}" is missing an accounts array`);
    }

    for (const handle of category.accounts) {
      if (typeof handle !== 'string' || !HANDLE.test(handle)) {
        throw new Error(`Invalid handle "${handle}" in category "${name}"`);
      }

      // Instagram handles are case-insensitive, so two spellings of one account
      // would be scraped twice and billed twice.
      const key = handle.toLowerCase();
      if (seen.has(key)) {
        throw new Error(`Duplicate handle "${handle}" in "${name}" and "${seen.get(key)}"`);
      }
      seen.set(key, name);
    }
  }
}

function validateEnv(updates) {
  const clean = {};

  for (const [key, raw] of Object.entries(updates)) {
    const rule = EDITABLE_ENV[key];
    if (!rule) throw new Error(`${key} is not editable from the web UI`);

    const value = String(raw).trim();
    const number = Number(value);

    if (!Number.isFinite(number)) {
      throw new Error(`${key} must be a ${rule.type === 'int' ? 'whole number' : 'number'}`);
    }
    if (rule.type === 'int' && !Number.isInteger(number)) {
      throw new Error(`${key} must be a whole number`);
    }
    if (number < rule.min || number > rule.max) {
      throw new Error(`${key} must be between ${rule.min} and ${rule.max}`);
    }

    clean[key] = value;
  }

  return clean;
}

export function readSettings(projectDir) {
  const accounts = JSON.parse(fs.readFileSync(accountsPath(projectDir), 'utf-8'));
  const parsed = parseEnv(readEnvText(projectDir));

  const env = {};
  for (const key of Object.keys(EDITABLE_ENV)) {
    if (parsed[key] !== undefined && parsed[key] !== '') env[key] = parsed[key];
  }

  const secrets = {};
  for (const key of REPORTED_SECRETS) {
    secrets[key] = parsed[key] ? 'set' : 'missing';
  }

  return { accounts, env, secrets };
}

export function writeSettings(projectDir, patch = {}) {
  // Validate everything before writing anything, so a bad handle in the third
  // category cannot leave .env updated and accounts.json not.
  if (patch.accounts) validateAccounts(patch.accounts);
  const envUpdates = patch.env ? validateEnv(patch.env) : null;

  if (patch.accounts) {
    const existing = JSON.parse(fs.readFileSync(accountsPath(projectDir), 'utf-8'));
    const merged = { ...existing, ...patch.accounts };
    writeAtomic(accountsPath(projectDir), JSON.stringify(merged, null, 2) + '\n');
  }

  if (envUpdates && Object.keys(envUpdates).length > 0) {
    writeAtomic(envPath(projectDir), updateEnvText(readEnvText(projectDir), envUpdates));
  }

  return readSettings(projectDir);
}
