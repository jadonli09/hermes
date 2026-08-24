import fs from 'fs';
import os from 'os';
import path from 'path';
import { createEventHub } from '../web/events.js';
import { createServer } from '../web/server.js';
import {
  reviewIssues, listReviewEvents, applyReviewUpdate, validateReviewUpdate,
  markAsRecap, REVIEW_CONFIDENCE
} from '../web/review.js';

const HEADER = ['Club', 'Date', 'Time', 'Type', 'Location', 'Post', 'Posted', 'Confidence', 'Description', 'Updated'];

const row = (over = {}) => {
  const data = {
    club_name: 'msjbio', event_date: '08/24/2026', event_time: 'Lunch',
    event_type: 'Club Meeting', location: 'B21', post_url: 'https://ig/p/A/',
    posted_date: '08/20/2026', confidence: '0.9', description: 'Weekly meeting', last_updated: '',
    ...over
  };
  return [
    data.club_name, data.event_date, data.event_time, data.event_type, data.location,
    data.post_url, data.posted_date, data.confidence, data.description, data.last_updated
  ];
};

// A fake Sheets client shaped like the slice of googleapis the module touches
function fakeSheets(rows) {
  const batchUpdates = [];
  return {
    batchUpdates,
    spreadsheets: {
      get: async () => ({ data: { sheets: [{ properties: { title: 'Events' } }] } }),
      values: {
        get: async () => ({ data: { values: [HEADER, ...rows] } }),
        batchUpdate: async (request) => { batchUpdates.push(request); return {}; }
      }
    }
  };
}

const ev = (over = {}) => ({
  club_name: 'msjbio', event_date: '08/24/2026', event_time: 'Lunch',
  event_type: 'Club Meeting', location: 'B21', confidence: '0.9', ...over
});

describe('reviewIssues', () => {
  it('passes a complete, confident event', () => {
    expect(reviewIssues(ev())).toEqual([]);
  });

  it('flags each missing story field by name', () => {
    expect(reviewIssues(ev({ event_date: '' }))).toEqual(['missing date']);
    expect(reviewIssues(ev({ event_time: '' }))).toEqual(['missing time']);
    expect(reviewIssues(ev({ location: '' }))).toEqual(['missing location']);
  });

  it('flags confidence below the review bar, even with every field present', () => {
    expect(reviewIssues(ev({ confidence: '0.5' }))).toEqual(['low confidence']);
    expect(reviewIssues(ev({ confidence: String(REVIEW_CONFIDENCE) }))).toEqual([]);
  });

  it('collects multiple issues on one row', () => {
    expect(reviewIssues(ev({ event_time: '', location: '', confidence: '0.4' })))
      .toEqual(['missing time', 'missing location', 'low confidence']);
  });

  it('does not flag rows with no confidence recorded, matching the publish filter', () => {
    expect(reviewIssues(ev({ confidence: '' }))).toEqual([]);
    expect(reviewIssues(ev({ confidence: 'n/a' }))).toEqual([]);
  });

  it('skips announcements, which never reach the story anyway', () => {
    expect(reviewIssues(ev({ event_type: 'Announcement', location: '' }))).toEqual([]);
  });

  it('skips recaps, so a marked row leaves the queue', () => {
    expect(reviewIssues(ev({ event_type: 'Recap', location: '', confidence: '0.2' }))).toEqual([]);
  });
});

describe('listReviewEvents', () => {
  it('returns only rows needing review, with their sheet row index', async () => {
    const sheets = fakeSheets([
      row(),                                                      // fine → skipped
      row({ club_name: 'msjart', location: '', post_url: 'https://ig/p/B/' })
    ]);

    const found = await listReviewEvents(sheets, 'sheet-1', '2026-08-23');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ club_name: 'msjart', rowIndex: 3, issues: ['missing location'] });
  });

  it('skips past events - their story has already gone out', async () => {
    const sheets = fakeSheets([
      row({ event_date: '08/01/2026', location: '' }),
      row({ club_name: 'msjart', event_date: '08/24/2026', location: '', post_url: 'https://ig/p/B/' })
    ]);

    const found = await listReviewEvents(sheets, 'sheet-1', '2026-08-23');
    expect(found.map(e => e.club_name)).toEqual(['msjart']);
  });

  it('always shows undated rows, sorted before dated ones', async () => {
    const sheets = fakeSheets([
      row({ club_name: 'msjlater', event_date: '09/01/2026', confidence: '0.2' }),
      row({ club_name: 'msjnodate', event_date: '', post_url: 'https://ig/p/B/' })
    ]);

    const found = await listReviewEvents(sheets, 'sheet-1', '2026-08-23');
    expect(found.map(e => e.club_name)).toEqual(['msjnodate', 'msjlater']);
  });

  it('ignores stray blank lines rather than reporting phantom events', async () => {
    const sheets = fakeSheets([row({ club_name: '', post_url: '', event_date: '', event_time: '', location: '', confidence: '', description: '' })]);
    expect(await listReviewEvents(sheets, 'sheet-1', '2026-08-23')).toEqual([]);
  });
});

describe('validateReviewUpdate', () => {
  it('accepts a partial edit and drops untouched blanks', () => {
    const clean = validateReviewUpdate(5, { location: ' C12 ', event_time: '' });
    expect(clean).toEqual({ rowIndex: 5, fields: { location: 'C12' } });
  });

  it('rejects the header row and nonsense row indices', () => {
    expect(() => validateReviewUpdate(1, { location: 'C12' })).toThrow(/rowIndex/);
    expect(() => validateReviewUpdate('abc', { location: 'C12' })).toThrow(/rowIndex/);
  });

  it('rejects fields the panel does not own, like confidence', () => {
    expect(() => validateReviewUpdate(2, { confidence: '1' })).toThrow(/not editable/);
    expect(() => validateReviewUpdate(2, { club_name: 'x' })).toThrow(/not editable/);
  });

  it('rejects a malformed date instead of writing it', () => {
    expect(() => validateReviewUpdate(2, { event_date: '8/24/26' })).toThrow(/YYYY-MM-DD/);
  });

  it('rejects an edit with nothing in it', () => {
    expect(() => validateReviewUpdate(2, {})).toThrow(/Nothing to save/);
    expect(() => validateReviewUpdate(2, { location: '  ' })).toThrow(/Nothing to save/);
  });
});

describe('applyReviewUpdate', () => {
  it('writes only the edited cells plus verification stamps', async () => {
    const sheets = fakeSheets([row()]);
    const result = await applyReviewUpdate(sheets, 'sheet-1', 2, { location: 'C12', event_time: 'Lunch' });

    expect(result).toEqual({ rowIndex: 2, updated: ['location', 'event_time'] });
    expect(sheets.batchUpdates).toHaveLength(1);

    const { data, valueInputOption } = sheets.batchUpdates[0].resource;
    expect(valueInputOption).toBe('USER_ENTERED');

    const byRange = Object.fromEntries(data.map(d => [d.range, d.values[0][0]]));
    expect(byRange['Events!E2']).toBe('C12');
    expect(byRange['Events!C2']).toBe('Lunch');
    expect(byRange['Events!H2']).toBe('1');                       // human verified
    expect(byRange['Events!J2']).toMatch(/^\d{4}-\d{2}-\d{2} /);  // last_updated stamp
    expect(Object.keys(byRange)).toHaveLength(4);                 // nothing else touched
  });

  it('converts the date to the sheet\'s MM/DD/YYYY before writing', async () => {
    const sheets = fakeSheets([row()]);
    await applyReviewUpdate(sheets, 'sheet-1', 2, { event_date: '2026-08-24' });

    const byRange = Object.fromEntries(sheets.batchUpdates[0].resource.data.map(d => [d.range, d.values[0][0]]));
    expect(byRange['Events!B2']).toBe('08/24/2026');
  });

  it('writes nothing when validation fails', async () => {
    const sheets = fakeSheets([row()]);
    await expect(applyReviewUpdate(sheets, 'sheet-1', 2, { event_date: 'tomorrow' })).rejects.toThrow();
    expect(sheets.batchUpdates).toHaveLength(0);
  });
});

describe('markAsRecap', () => {
  it('sets the event type to Recap and stamps verification, touching nothing else', async () => {
    const sheets = fakeSheets([row()]);
    const result = await markAsRecap(sheets, 'sheet-1', 2);

    expect(result).toEqual({ rowIndex: 2, event_type: 'Recap' });

    const byRange = Object.fromEntries(sheets.batchUpdates[0].resource.data.map(d => [d.range, d.values[0][0]]));
    expect(byRange['Events!D2']).toBe('Recap');
    expect(byRange['Events!H2']).toBe('1');
    expect(byRange['Events!J2']).toMatch(/^\d{4}-\d{2}-\d{2} /);
    expect(Object.keys(byRange)).toHaveLength(3);
  });

  it('rejects the header row without writing', async () => {
    const sheets = fakeSheets([row()]);
    await expect(markAsRecap(sheets, 'sheet-1', 1)).rejects.toThrow(/rowIndex/);
    expect(sheets.batchUpdates).toHaveLength(0);
  });
});

describe('the review API', () => {
  let dir, server, base, sheets;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-review-'));
    fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({
      categories: { clubs: { enabled: true, accounts: ['msjbio'] } }
    }));
    fs.writeFileSync(path.join(dir, '.env'), 'GOOGLE_SPREADSHEET_ID=sheet-1\n');

    sheets = fakeSheets([
      row({ club_name: 'msjart', event_date: '12/01/2099', location: '', post_url: 'https://ig/p/B/' })
    ]);

    const runner = { getActive: () => null, start: () => ({ runId: 'r' }), cancel: () => false };
    server = createServer({
      projectDir: dir, dataDir: dir, storyDir: dir,
      runner, hub: createEventHub(), sheetsClient: sheets
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lists events needing review', async () => {
    const response = await fetch(`${base}/api/review`);
    expect(response.status).toBe(200);

    const { events } = await response.json();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ club_name: 'msjart', rowIndex: 2, issues: ['missing location'] });
  });

  it('applies an edit through PUT', async () => {
    const response = await fetch(`${base}/api/review`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rowIndex: 2, fields: { location: 'C12' } })
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ rowIndex: 2, updated: ['location'] });
    expect(sheets.batchUpdates).toHaveLength(1);
  });

  it('marks a row as recap through POST', async () => {
    const response = await fetch(`${base}/api/review/recap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rowIndex: 2 })
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ rowIndex: 2, event_type: 'Recap' });

    const byRange = Object.fromEntries(sheets.batchUpdates[0].resource.data.map(d => [d.range, d.values[0][0]]));
    expect(byRange['Events!D2']).toBe('Recap');
  });

  it('rejects a recap with a bad row index and writes nothing', async () => {
    const response = await fetch(`${base}/api/review/recap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rowIndex: 0 })
    });

    expect(response.status).toBe(400);
    expect(sheets.batchUpdates).toHaveLength(0);
  });

  it('rejects a bad edit with 400 and writes nothing', async () => {
    const response = await fetch(`${base}/api/review`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rowIndex: 1, fields: { location: 'C12' } })
    });

    expect(response.status).toBe(400);
    expect(sheets.batchUpdates).toHaveLength(0);
  });

  it('reports a missing spreadsheet id instead of failing opaquely', async () => {
    fs.writeFileSync(path.join(dir, '.env'), '');
    const response = await fetch(`${base}/api/review`);
    expect(response.status).toBe(500);
    expect((await response.json()).error).toMatch(/GOOGLE_SPREADSHEET_ID/);
  });
});
