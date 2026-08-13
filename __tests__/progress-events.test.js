import { emit, setSink, resetSink } from '../utils/progress-events.js';

describe('progress events', () => {
  let lines;

  beforeEach(() => {
    lines = [];
    setSink(line => lines.push(line));
  });

  afterEach(() => {
    resetSink();
    delete process.env.HERMES_PROGRESS;
  });

  it('writes nothing when HERMES_PROGRESS is unset', () => {
    emit('phase', { name: 'process' });
    expect(lines).toEqual([]);
  });

  it('writes one newline-terminated JSON object when enabled', () => {
    process.env.HERMES_PROGRESS = 'json';
    emit('phase', { name: 'process' });

    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith('\n')).toBe(true);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.t).toBe('phase');
    expect(parsed.name).toBe('process');
    expect(typeof parsed.at).toBe('number');
  });

  it('carries the whole payload through', () => {
    process.env.HERMES_PROGRESS = 'json';
    emit('club:done', { index: 3, total: 85, account: 'msjbio', postsFound: 2, eventsExtracted: 1 });

    expect(JSON.parse(lines[0])).toMatchObject({
      t: 'club:done', index: 3, total: 85, account: 'msjbio', postsFound: 2, eventsExtracted: 1
    });
  });

  it('falls silent after a write failure instead of throwing', () => {
    process.env.HERMES_PROGRESS = 'json';
    setSink(() => { throw new Error('EBADF'); });

    expect(() => emit('phase', { name: 'process' })).not.toThrow();

    // A run started by hand with HERMES_PROGRESS=json has no fd 3. One failed
    // write must not turn into thousands of them.
    let attempts = 0;
    const failing = () => { attempts++; throw new Error('EBADF'); };
    emit('phase', { name: 'write' });
    expect(attempts).toBe(0);

    // ...and setting a fresh sink re-arms it, so tests stay independent.
    setSink(failing);
    emit('phase', { name: 'write' });
    expect(attempts).toBe(1);
  });
});
