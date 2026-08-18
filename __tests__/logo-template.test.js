import { wordmarkSvg, squareSvg, PALETTE } from '../logo/template.js';

describe('logo template', () => {
  it('sets the wordmark in the story graphic palette, dark and light', () => {
    const dark = wordmarkSvg({ theme: 'dark' });
    const light = wordmarkSvg({ theme: 'light' });

    expect(dark).toContain('HERMES');
    expect(dark).toContain(`fill="${PALETTE.bone}"`);      // word on ink
    expect(dark).toContain(`fill="${PALETTE.sage}"`);      // prompt + cursor
    expect(light).toContain(`fill="${PALETTE.ink}"`);
    expect(light).toContain(`fill="${PALETTE.sage600}"`);
    expect(dark).not.toContain(PALETTE.ink);
  });

  it('carries the prompt chevron and a block cursor by default, and can drop the cursor', () => {
    const svg = wordmarkSvg({ theme: 'dark' });
    expect(svg).toContain('&gt;');
    expect(svg).toMatch(/<rect[^>]*class="cursor"/);
    expect(wordmarkSvg({ theme: 'dark', cursor: false })).not.toMatch(/class="cursor"/);
  });

  it('embeds JetBrains Mono so the SVG is portable', () => {
    const svg = wordmarkSvg({ theme: 'dark' });
    expect(svg).toContain("font-family:'JBMono'");
    expect(svg).toMatch(/src:url\(data:font\/woff2;base64,[A-Za-z0-9+/=]{100,}\)/);
  });

  it('is a standalone SVG document with a viewBox', () => {
    const svg = wordmarkSvg({ theme: 'light' });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toMatch(/viewBox="0 0 \d+ \d+"/);
  });

  it('builds a square mark of the prompt and the H, with or without its own background', () => {
    const tile = squareSvg({ theme: 'dark' });
    expect(tile).toMatch(/viewBox="0 0 1024 1024"/);
    expect(tile).toContain('&gt;');
    expect(tile).toContain('>H<');
    expect(tile).toContain(`fill="${PALETTE.ink}"`);           // background tile
    expect(squareSvg({ theme: 'dark', background: false })).not.toContain(`fill="${PALETTE.ink}"`);
  });
});
