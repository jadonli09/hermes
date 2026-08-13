// Emits a well-formed run on fd 3, then exits cleanly.
import fs from 'fs';

fs.writeSync(3, JSON.stringify({ t: 'run:config', accounts: 2, startDate: '2026-08-05' }) + '\n');
fs.writeSync(3, JSON.stringify({ t: 'club:start', index: 1, total: 2, account: 'msjbio' }) + '\n');
fs.writeSync(3, JSON.stringify({ t: 'club:done', index: 1, total: 2, account: 'msjbio', postsFound: 3, eventsExtracted: 2 }) + '\n');
console.log('human readable output');
fs.writeSync(3, JSON.stringify({ t: 'summary', summary: { clubsProcessed: 2 } }) + '\n');
process.exit(0);
