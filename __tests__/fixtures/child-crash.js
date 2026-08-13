// Mirrors main.js:191 - prints to stderr and exits nonzero.
import fs from 'fs';

fs.writeSync(3, JSON.stringify({ t: 'phase', name: 'prefetch' }) + '\n');
console.error('Apify API 402: out of credit');
process.exit(1);
