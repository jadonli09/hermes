import { DAYS, normalizeRecurringRows, isBlankRow, sameSettings } from '../web/public/settings-form.js';

const row = (over = {}) => ({ club: 'Writer\'s Block', days: ['Tue'], time: 'Lunch', location: 'E2A', ...over });

describe('normalizeRecurringRows', () => {
  it('trims the text fields', () => {
    expect(normalizeRecurringRows([row({ club: '  Writer\'s Block ', time: ' Lunch', location: 'E2A  ' })]))
      .toEqual([{ club: "Writer's Block", days: ['Tue'], time: 'Lunch', location: 'E2A' }]);
  });

  it('puts days in week order however they arrive', () => {
    expect(normalizeRecurringRows([row({ days: ['Thu', 'Tue'] })])[0].days).toEqual(['Tue', 'Thu']);
    expect(normalizeRecurringRows([row({ days: ['sun', 'MON'] })])[0].days).toEqual(['Mon', 'Sun']);
  });

  it('drops days it does not recognise rather than passing them on', () => {
    expect(normalizeRecurringRows([row({ days: ['Tue', 'Funday'] })])[0].days).toEqual(['Tue']);
  });

  it('fills in a row that arrived without fields, so painting it cannot throw', () => {
    expect(normalizeRecurringRows([{}])).toEqual([{ club: '', days: [], time: '', location: '' }]);
    expect(normalizeRecurringRows(undefined)).toEqual([]);
  });

  // The point of sharing one normalizer: a row that has round-tripped through
  // the server must compare equal to the one the form collects.
  it('is idempotent', () => {
    const once = normalizeRecurringRows([row({ days: ['Thu', 'Tue'] })]);
    expect(normalizeRecurringRows(once)).toEqual(once);
  });

  it('covers every day of the week', () => {
    expect(normalizeRecurringRows([row({ days: [...DAYS].reverse() })])[0].days).toEqual(DAYS);
  });
});

describe('isBlankRow', () => {
  it('is true only for a row with nothing in it at all', () => {
    expect(isBlankRow({ club: '', days: [], time: '', location: '' })).toBe(true);
  });

  it('is false for a half-filled row, which should be reported and not dropped', () => {
    expect(isBlankRow({ club: 'Chess', days: [], time: '', location: '' })).toBe(false);
    expect(isBlankRow({ club: '', days: ['Wed'], time: '', location: '' })).toBe(false);
    expect(isBlankRow({ club: '', days: [], time: 'Lunch', location: '' })).toBe(false);
    expect(isBlankRow({ club: '', days: [], time: '', location: 'C120' })).toBe(false);
  });
});

describe('sameSettings', () => {
  const saved = {
    accounts: { categories: { clubs: { enabled: true, accounts: ['msjbio'] } } },
    recurring: { meetings: [{ club: 'DECA', days: ['Wed'], time: 'After School', location: 'C120' }] },
    env: { START_DAYS_AGO: '7' }
  };
  const copy = () => JSON.parse(JSON.stringify(saved));

  it('holds a round-tripped copy equal', () => {
    expect(sameSettings(copy(), saved)).toBe(true);
  });

  it('ignores key order', () => {
    expect(sameSettings({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it('notices an edited meeting', () => {
    const edited = copy();
    edited.recurring.meetings[0].location = 'C121';
    expect(sameSettings(edited, saved)).toBe(false);
  });

  it('notices an added or removed meeting', () => {
    const added = copy();
    added.recurring.meetings.push({ club: 'Club Council', days: ['Wed'], time: 'Lunch', location: 'C120' });
    expect(sameSettings(added, saved)).toBe(false);

    const removed = copy();
    removed.recurring.meetings = [];
    expect(sameSettings(removed, saved)).toBe(false);
  });

  it('notices a day toggled on or off', () => {
    const edited = copy();
    edited.recurring.meetings[0].days = ['Wed', 'Thu'];
    expect(sameSettings(edited, saved)).toBe(false);
  });

  it('notices an edited handle, category toggle, or run setting', () => {
    const handle = copy();
    handle.accounts.categories.clubs.accounts.push('msjchemclub');
    expect(sameSettings(handle, saved)).toBe(false);

    const toggled = copy();
    toggled.accounts.categories.clubs.enabled = false;
    expect(sameSettings(toggled, saved)).toBe(false);

    const env = copy();
    env.env.START_DAYS_AGO = '14';
    expect(sameSettings(env, saved)).toBe(false);
  });

  it('does not confuse a missing key with an undefined one', () => {
    expect(sameSettings({ env: {} }, { env: { START_DAYS_AGO: undefined } })).toBe(false);
    expect(sameSettings({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it('keeps arrays and objects apart, and handles null', () => {
    expect(sameSettings([], {})).toBe(false);
    expect(sameSettings(null, {})).toBe(false);
    expect(sameSettings(null, null)).toBe(true);
    expect(sameSettings(['Tue'], ['Wed'])).toBe(false);
  });

  it('does not treat a reordered array as equal - day order is meaningful', () => {
    expect(sameSettings(['Tue', 'Thu'], ['Thu', 'Tue'])).toBe(false);
  });
});
