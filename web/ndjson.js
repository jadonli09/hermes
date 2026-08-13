// Turning a byte stream into events has two classic failure modes, and both
// produce a dashboard that is confidently wrong rather than obviously broken:
// a line split across two reads, and a multi-byte character split across two
// reads. StringDecoder handles the second; the buffer here handles the first.
import { StringDecoder } from 'node:string_decoder';

export function createLineDecoder() {
  const decoder = new StringDecoder('utf8');
  let buffer = '';

  return {
    push(chunk) {
      buffer += decoder.write(chunk);

      const parts = buffer.split('\n');
      buffer = parts.pop();   // '' when the chunk happened to end on a newline

      return parts.filter(line => line.trim() !== '');
    },

    flush() {
      const rest = (buffer + decoder.end()).trim();
      buffer = '';
      return rest ? [rest] : [];
    }
  };
}

/**
 * @returns {Object|null} - null for anything that is not a tagged event object.
 *   Callers count the nulls and carry on: one garbled line must never end a
 *   live run.
 */
export function parseEvent(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (typeof parsed.t !== 'string') return null;

  return parsed;
}
