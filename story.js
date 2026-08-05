// Daily Instagram story generator.
//
//   npm run story                        today
//   npm run story -- --date=2026-02-10   a specific day
//   npm run story -- --out=./out         write locally instead of uploading
//
// Reads the spreadsheet, not a scrape run - see the design spec for why.
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { getCredentialsPath } from './config-manager.js';
import { fetchEventsForDate } from './story/event-source.js';
import { sortEvents, paginate } from './story/paginate.js';
import { buildPage } from './story/template.js';
import { renderPages } from './story/render.js';
import { authenticateDrive, uploadImage, assertFolderWritable } from './story/drive.js';

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { date: null, out: null };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    if (key === 'date') args.date = value;
    if (key === 'out') args.out = value || './out';
  }
  return args;
}

function todayIso() {
  // Local date: "today" means the school's today, not UTC's
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('-');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const isoDate = args.date || todayIso();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    throw new Error(`Invalid --date "${isoDate}". Expected YYYY-MM-DD.`);
  }

  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error('GOOGLE_SPREADSHEET_ID must be set in .env');

  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  const credentialsPath = getCredentialsPath(__dirname);

  console.log('='.repeat(56));
  console.log(`Story for ${isoDate}`);
  console.log('='.repeat(56));

  // Check Drive before doing any work, so a permissions problem does not surface
  // only after rendering
  let drive = null;
  if (!args.out) {
    if (!folderId) {
      throw new Error(
        'GOOGLE_DRIVE_FOLDER_ID must be set in .env, or pass --out=<dir> to write locally'
      );
    }
    drive = await authenticateDrive(credentialsPath);
    const email = JSON.parse(fs.readFileSync(credentialsPath, 'utf-8')).client_email;
    const folder = await assertFolderWritable(drive, folderId, email);
    console.log(`✓ Drive folder: ${folder.name}`);
  }

  const events = sortEvents(await fetchEventsForDate(credentialsPath, spreadsheetId, isoDate));
  console.log(`✓ ${events.length} event(s) on ${isoDate}`);

  // A quiet day is not a failure. Weekends, holidays and summer are normal, and
  // a story reading "no events today" is worse than no story.
  if (events.length === 0) {
    console.log('\nNothing to post. No images generated.');
    return;
  }

  const pages = paginate(events);
  console.log(`✓ ${pages.length} page(s): [${pages.map(p => p.length).join(', ')}]`);

  const html = pages.map((pageEvents, i) => buildPage({
    isoDate,
    events: pageEvents,
    page: i + 1,
    totalPages: pages.length,
    totalEvents: events.length
  }));

  const images = await renderPages(html);
  console.log(`✓ Rendered ${images.length} image(s)`);

  if (args.out) {
    fs.mkdirSync(args.out, { recursive: true });
    for (const [i, buffer] of images.entries()) {
      const file = path.join(args.out, `story-${isoDate}-p${i + 1}.png`);
      fs.writeFileSync(file, buffer);
      console.log(`  ${file}`);
    }
  } else {
    for (const [i, buffer] of images.entries()) {
      const name = `story-${isoDate}-p${i + 1}.png`;
      const result = await uploadImage(drive, folderId, name, buffer);
      console.log(`  ${result.replaced ? 'replaced' : 'uploaded'} ${name}`);
    }
  }

  console.log('\n✅ Done');
}

main().catch(error => {
  console.error('\n❌ ' + error.message);
  process.exit(1);
});
