// A malformed line between two good ones must not end the run.
import fs from 'fs';

fs.writeSync(3, JSON.stringify({ t: 'phase', name: 'prefetch' }) + '\n');
fs.writeSync(3, 'not json at all\n');
fs.writeSync(3, '{"missing":"type tag"}\n');
fs.writeSync(3, JSON.stringify({ t: 'phase', name: 'process' }) + '\n');
process.exit(0);
