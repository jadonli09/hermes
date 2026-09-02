import fs from 'fs';
import os from 'os';
import path from 'path';
import { readSettings, writeSettings, updateEnvText } from '../web/settings.js';

let dir;

const accountsFixture = {
  categories: {
    clubs: { description: 'Student clubs', enabled: true, accounts: ['msjbio', 'msjchemclub'] },
    asb: { description: 'ASB', enabled: true, accounts: ['msjhsac'] },
    old: { description: 'Disbanded', enabled: false, accounts: ['gone'] }
  },
  settings: { defaultCategory: 'clubs' }
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-settings-'));
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify(accountsFixture, null, 2));
  fs.writeFileSync(path.join(dir, '.env'), [
    '# Hermes configuration',
    'APIFY_TOKEN=apify_api_secret',
    'ANTHROPIC_API_KEY=sk-ant-secret',
    'START_DAYS_AGO=7',
    '# END_DATE=',
    'MAX_CLUBS_TO_PROCESS=100',
    ''
  ].join('\n'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('readSettings', () => {
  it('returns accounts, editable env values, and secret presence only', () => {
    const settings = readSettings(dir);

    expect(settings.accounts.categories.clubs.accounts).toEqual(['msjbio', 'msjchemclub']);
    expect(settings.env.START_DAYS_AGO).toBe('7');
    expect(settings.env.MAX_CLUBS_TO_PROCESS).toBe('100');

    // The whole point of the allowlist: a UI bug cannot leak what it never reads.
    expect(settings.secrets).toEqual({
      APIFY_TOKEN: 'set',
      ANTHROPIC_API_KEY: 'set',
      GOOGLE_SPREADSHEET_ID: 'missing'
    });
    expect(JSON.stringify(settings)).not.toContain('apify_api_secret');
    expect(JSON.stringify(settings)).not.toContain('sk-ant-secret');
  });
});

describe('writeSettings', () => {
  it('adds and removes accounts', () => {
    writeSettings(dir, {
      accounts: {
        categories: {
          ...accountsFixture.categories,
          clubs: { ...accountsFixture.categories.clubs, accounts: ['msjbio', 'msjrobotics'] }
        }
      }
    });

    const written = JSON.parse(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf-8'));
    expect(written.categories.clubs.accounts).toEqual(['msjbio', 'msjrobotics']);
    expect(written.settings.defaultCategory).toBe('clubs');   // untouched keys survive
  });

  it('rejects a handle that is not a valid Instagram username', () => {
    expect(() => writeSettings(dir, {
      accounts: { categories: { clubs: { enabled: true, accounts: ['not a handle!'] } } }
    })).toThrow(/invalid handle/i);
  });

  it('rejects duplicate handles across categories', () => {
    expect(() => writeSettings(dir, {
      accounts: {
        categories: {
          clubs: { enabled: true, accounts: ['msjbio'] },
          asb: { enabled: true, accounts: ['MSJBio'] }
        }
      }
    })).toThrow(/duplicate/i);
  });

  it('updates an allowlisted env value in place', () => {
    writeSettings(dir, { env: { START_DAYS_AGO: '14' } });

    const text = fs.readFileSync(path.join(dir, '.env'), 'utf-8');
    expect(text).toContain('START_DAYS_AGO=14');
    expect(text).toContain('# Hermes configuration');        // comments preserved
    expect(text).toContain('APIFY_TOKEN=apify_api_secret');   // secrets untouched
  });

  it('refuses to write a key that is not on the allowlist', () => {
    expect(() => writeSettings(dir, { env: { APIFY_TOKEN: 'stolen' } })).toThrow(/not editable/i);
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf-8')).toContain('apify_api_secret');
  });

  it('range-checks numeric values', () => {
    expect(() => writeSettings(dir, { env: { START_DAYS_AGO: '-1' } })).toThrow(/between/i);
    expect(() => writeSettings(dir, { env: { START_DAYS_AGO: '9999' } })).toThrow(/between/i);
    expect(() => writeSettings(dir, { env: { START_DAYS_AGO: 'soon' } })).toThrow(/whole number/i);
    expect(() => writeSettings(dir, { env: { START_DAYS_AGO: '2.5' } })).toThrow(/whole number/i);
  });

  it('accepts a decimal for the cost ceiling', () => {
    const settings = writeSettings(dir, { env: { APIFY_MAX_CHARGE_USD: '1.5' } });
    expect(settings.env.APIFY_MAX_CHARGE_USD).toBe('1.5');
  });

  it('leaves no partial file behind on a validation failure', () => {
    const before = fs.readFileSync(path.join(dir, 'accounts.json'), 'utf-8');

    expect(() => writeSettings(dir, {
      accounts: { categories: { clubs: { enabled: true, accounts: ['bad handle'] } } },
      env: { START_DAYS_AGO: '14' }
    })).toThrow();

    // Validation runs before any write, so a bad handle cannot leave .env
    // updated and accounts.json not.
    expect(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf-8')).toBe(before);
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf-8')).toContain('START_DAYS_AGO=7');
    expect(fs.readdirSync(dir).filter(f => f.includes('.tmp'))).toEqual([]);
  });
});

describe('recurring meetings settings', () => {
  const lifting = { club: 'Lifting Club', days: ['Tue', 'Thu'], time: 'Lunch', location: 'Weight Room' };

  it('reads an empty list before the file exists', () => {
    expect(readSettings(dir).recurring).toEqual({ meetings: [] });
  });

  it('round-trips a meetings list through writeSettings', () => {
    const settings = writeSettings(dir, { recurring: { meetings: [lifting] } });
    expect(settings.recurring.meetings).toEqual([lifting]);

    const written = JSON.parse(fs.readFileSync(path.join(dir, 'recurring.json'), 'utf-8'));
    expect(written.meetings).toEqual([lifting]);
  });

  it('rejects invalid meetings without writing anything', () => {
    expect(() => writeSettings(dir, {
      recurring: { meetings: [{ ...lifting, days: ['Someday'] }] }
    })).toThrow(/day/i);

    expect(fs.existsSync(path.join(dir, 'recurring.json'))).toBe(false);
    expect(fs.readdirSync(dir).filter(f => f.includes('.tmp'))).toEqual([]);
  });

  it('validates recurring before writing accounts, so a bad meeting leaves both untouched', () => {
    const before = fs.readFileSync(path.join(dir, 'accounts.json'), 'utf-8');

    expect(() => writeSettings(dir, {
      accounts: { categories: { clubs: { enabled: true, accounts: ['msjbio'] } } },
      recurring: { meetings: [{ ...lifting, club: '' }] }
    })).toThrow();

    expect(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf-8')).toBe(before);
  });
});

describe('updateEnvText', () => {
  it('replaces an existing assignment without touching anything else', () => {
    expect(updateEnvText('A=1\n# comment\nB=2\n', { B: '9' })).toBe('A=1\n# comment\nB=9\n');
  });

  it('appends a key that is only present commented out', () => {
    // Rewriting the commented line would leave the file reading as "disabled"
    // while the value was actually live.
    expect(updateEnvText('# START_DAYS_AGO=7\n', { START_DAYS_AGO: '14' }))
      .toBe('# START_DAYS_AGO=7\nSTART_DAYS_AGO=14\n');
  });

  it('appends a key that is absent entirely', () => {
    expect(updateEnvText('A=1\n', { B: '2' })).toBe('A=1\nB=2\n');
  });

  it('adds a newline before appending to a file that lacks one', () => {
    expect(updateEnvText('A=1', { B: '2' })).toBe('A=1\nB=2\n');
  });
});
