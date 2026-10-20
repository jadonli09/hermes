import { jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sendEmail } from '../automation/email.js';
let dir, files;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-email-test-'));
  files = [1, 2].map(i => { const file = path.join(dir, `story-2026-10-14-p${i}.png`); fs.writeFileSync(file, 'fixture'); return file; });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const address = 'ai.jadonli09@gmail.com';
const fakeSpawn = code => jest.fn(() => { const child = new EventEmitter(); child.kill = jest.fn(); queueMicrotask(() => child.emit('close', code)); return child; });
test('one Mail invocation includes both attachments and exact sender/destination', async () => {
  const spawnProcess = fakeSpawn(0);
  await sendEmail(files, address, { fromAddress: address, targetDate: '2026-10-14', spawnProcess });
  expect(spawnProcess).toHaveBeenCalledTimes(1);
  expect(spawnProcess.mock.calls[0][1].slice(2, 5)).toEqual([address, address, 'Hermes — 2026-10-14']);
  expect(spawnProcess.mock.calls[0][1].slice(-2)).toEqual(files);
});
test('wrong sender, wrong destination, and reordered attachments never invoke Mail', async () => {
  const spawnProcess = fakeSpawn(0), opts = { fromAddress: address, targetDate: '2026-10-14', spawnProcess };
  await expect(sendEmail(files, 'other@example.com', opts)).rejects.toThrow(/recipient/);
  await expect(sendEmail(files, address, { ...opts, fromAddress: 'other@example.com' })).rejects.toThrow(/sender/);
  await expect(sendEmail([...files].reverse(), address, opts)).rejects.toThrow(/attachment/);
  expect(spawnProcess).not.toHaveBeenCalled();
});
test('Mail failure is reported without retrying', async () => {
  const spawnProcess = fakeSpawn(1);
  await expect(sendEmail(files, address, { fromAddress: address, targetDate: '2026-10-14', spawnProcess })).rejects.toThrow(/uncertain/);
  expect(spawnProcess).toHaveBeenCalledTimes(1);
});
