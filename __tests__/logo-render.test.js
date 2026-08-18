import fs from 'fs';
import os from 'os';
import path from 'path';
import { renderLogoSet, LOGO_FILES } from '../logo/render.js';

const pngSize = (file) => {
  const buf = fs.readFileSync(file);
  expect(buf.subarray(1, 4).toString()).toBe('PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
};

describe('renderLogoSet', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-logo-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('writes every asset in the set at its stated pixel size', async () => {
    const written = await renderLogoSet(dir);

    expect(written.sort()).toEqual(LOGO_FILES.map(f => f.name).sort());
    for (const spec of LOGO_FILES) {
      const file = path.join(dir, spec.name);
      expect(fs.existsSync(file)).toBe(true);
      if (spec.name.endsWith('.png')) {
        expect(pngSize(file)).toEqual({ width: spec.width, height: spec.height });
      }
    }
  }, 60000);

  it('includes the forms that were asked for: square, thumbnail, header, favicon, wordmarks, and svg sources', () => {
    const names = LOGO_FILES.map(f => f.name);
    expect(names).toEqual(expect.arrayContaining([
      'hermes-square-1024.png', 'hermes-square-light-1024.png', 'hermes-square-512.png',
      'hermes-thumbnail-256.png',
      'hermes-header-1600x400.png', 'hermes-header-light-1600x400.png',
      'hermes-social-1280x640.png',
      'hermes-wordmark-dark.png', 'hermes-wordmark-light.png',
      'hermes-wordmark-dark.svg', 'hermes-wordmark-light.svg', 'hermes-square.svg',
      'favicon.svg', 'favicon-32.png', 'favicon-16.png', 'apple-touch-icon-180.png'
    ]));
  });
});
