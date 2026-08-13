import { createLineDecoder, parseEvent } from '../web/ndjson.js';

describe('createLineDecoder', () => {
  it('returns complete lines and holds the partial one back', () => {
    const d = createLineDecoder();
    expect(d.push(Buffer.from('{"a":1}\n{"b":2}\n{"c":'))).toEqual(['{"a":1}', '{"b":2}']);
    expect(d.push(Buffer.from('3}\n'))).toEqual(['{"c":3}']);
  });

  it('reassembles a line split across many chunks', () => {
    const d = createLineDecoder();
    for (const piece of ['{"t":', '"phase",', '"name":', '"process"}']) {
      expect(d.push(Buffer.from(piece))).toEqual([]);
    }
    expect(d.push(Buffer.from('\n'))).toEqual(['{"t":"phase","name":"process"}']);
  });

  it('reassembles a multi-byte character split across chunks', () => {
    // Club captions and log lines carry emoji and check marks. Decoding each
    // chunk independently would turn a split code point into replacement
    // characters and corrupt the JSON around it.
    const full = Buffer.from('{"t":"log","message":"✓ done"}\n', 'utf8');
    const d = createLineDecoder();
    const cut = full.indexOf(Buffer.from('✓', 'utf8')) + 1;

    expect(d.push(full.subarray(0, cut))).toEqual([]);
    expect(d.push(full.subarray(cut))).toEqual(['{"t":"log","message":"✓ done"}']);
  });

  it('skips blank lines', () => {
    const d = createLineDecoder();
    expect(d.push(Buffer.from('\n\n{"a":1}\n'))).toEqual(['{"a":1}']);
  });

  it('flush returns a trailing line that never got its newline', () => {
    const d = createLineDecoder();
    d.push(Buffer.from('{"a":1}'));
    expect(d.flush()).toEqual(['{"a":1}']);
    expect(d.flush()).toEqual([]);
  });
});

describe('parseEvent', () => {
  it('parses a well-formed event', () => {
    expect(parseEvent('{"t":"phase","name":"write"}')).toEqual({ t: 'phase', name: 'write' });
  });

  it('returns null for malformed JSON rather than throwing', () => {
    expect(parseEvent('{"t":')).toBeNull();
    expect(parseEvent('not json at all')).toBeNull();
  });

  it('returns null for JSON without a string type tag', () => {
    expect(parseEvent('{"name":"write"}')).toBeNull();
    expect(parseEvent('{"t":42}')).toBeNull();
    expect(parseEvent('null')).toBeNull();
    expect(parseEvent('[1,2,3]')).toBeNull();
  });
});
