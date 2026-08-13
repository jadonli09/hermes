// Writes one event in three separate writes with the newline last, which is
// what a real pipe delivers when an event straddles a buffer boundary.
import fs from 'fs';

fs.writeSync(3, '{"t":"club:start",');
fs.writeSync(3, '"index":1,"total":1,');
fs.writeSync(3, '"account":"msjbio"}\n');
process.exit(0);
