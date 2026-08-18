// Regenerates assets/logo from logo/template.js.
//
//   npm run logo
import path from 'path';
import { fileURLToPath } from 'url';
import { renderLogoSet } from './logo/render.js';

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets', 'logo');
const written = await renderLogoSet(outDir);
console.log(`Wrote ${written.length} files to ${outDir}`);
for (const name of written) console.log(`  ${name}`);
