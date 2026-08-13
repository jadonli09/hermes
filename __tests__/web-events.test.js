import { createEventHub } from '../web/events.js';

const fakeRes = () => ({
  headers: null,
  chunks: [],
  writeHead(code, headers) { this.headers = { code, ...headers }; },
  write(chunk) { this.chunks.push(chunk); return true; },
  end() {},
  on() {}
});

describe('createEventHub', () => {
  it('assigns monotonic seq numbers per run', () => {
    const hub = createEventHub();
    expect(hub.publish('r1', { t: 'phase' }).seq).toBe(1);
    expect(hub.publish('r1', { t: 'phase' }).seq).toBe(2);
    expect(hub.publish('r2', { t: 'phase' }).seq).toBe(1);
  });

  it('delivers events to a subscriber as SSE frames', () => {
    const hub = createEventHub();
    const res = fakeRes();
    hub.subscribe('r1', res);
    hub.publish('r1', { t: 'phase', name: 'write' });

    expect(res.headers.code).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/event-stream');

    const frame = res.chunks.join('');
    expect(frame).toContain('id: 1\n');
    expect(frame).toContain('"name":"write"');
    expect(frame.endsWith('\n\n')).toBe(true);
  });

  it('replays buffered events to a subscriber that joins mid-run', () => {
    const hub = createEventHub();
    hub.publish('r1', { t: 'phase', name: 'prefetch' });
    hub.publish('r1', { t: 'phase', name: 'process' });

    const res = fakeRes();
    hub.subscribe('r1', res);

    const frames = res.chunks.join('');
    expect(frames).toContain('prefetch');
    expect(frames).toContain('process');
  });

  it('replays only what a reconnecting client missed', () => {
    const hub = createEventHub();
    hub.publish('r1', { t: 'phase', name: 'prefetch' });
    hub.publish('r1', { t: 'phase', name: 'process' });

    const res = fakeRes();
    hub.subscribe('r1', res, { lastEventId: '1' });

    const frames = res.chunks.join('');
    expect(frames).not.toContain('prefetch');
    expect(frames).toContain('process');
  });

  it('stops writing to a subscriber after it unsubscribes', () => {
    const hub = createEventHub();
    const res = fakeRes();
    const unsubscribe = hub.subscribe('r1', res);
    unsubscribe();

    hub.publish('r1', { t: 'phase', name: 'write' });
    expect(res.chunks.join('')).not.toContain('write');
  });

  it('survives a subscriber whose socket throws on write', () => {
    const hub = createEventHub();
    const bad = { ...fakeRes(), chunks: [], write() { throw new Error('EPIPE'); } };
    const good = fakeRes();
    hub.subscribe('r1', bad);
    hub.subscribe('r1', good);

    // A dead socket is routine - the browser closed the tab. It must not take
    // the run's other subscribers with it.
    expect(() => hub.publish('r1', { t: 'phase', name: 'write' })).not.toThrow();
    expect(good.chunks.join('')).toContain('write');
  });

  it('caps the buffer so a long run cannot exhaust memory', () => {
    const hub = createEventHub({ maxBuffer: 3 });
    for (let i = 0; i < 10; i++) hub.publish('r1', { t: 'log', message: `m${i}` });

    const buffered = hub.getBuffer('r1');
    expect(buffered).toHaveLength(3);
    expect(buffered.at(-1).message).toBe('m9');
  });

  it('filters the buffer by seq', () => {
    const hub = createEventHub();
    hub.publish('r1', { t: 'log', message: 'a' });
    hub.publish('r1', { t: 'log', message: 'b' });

    expect(hub.getBuffer('r1', { since: 1 }).map(e => e.message)).toEqual(['b']);
  });

  it('forgets a run once cleared', () => {
    const hub = createEventHub();
    hub.publish('r1', { t: 'log', message: 'a' });
    hub.clear('r1');

    expect(hub.getBuffer('r1')).toEqual([]);
  });
});
