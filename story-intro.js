// One-time introduction story for the @msjclubs account.
//
//   npm run story:intro                  into STORY_OUT_DIR
//   npm run story:intro -- --out=./out   override the destination
//
// Same destination logic as the daily story: a directory if one is configured,
// otherwise the Drive folder.
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { getCredentialsPath } from './config-manager.js';
import { buildIntroPage } from './story/intro.js';
import { renderPages } from './story/render.js';
import { authenticateDrive, uploadImage, assertFolderWritable } from './story/drive.js';

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { out: null };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    if (key === 'out') args.out = value || './out';
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = args.out || process.env.STORY_OUT_DIR || null;
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

  console.log('='.repeat(56));
  console.log('Hermes introduction story');
  console.log('='.repeat(56));

  let drive = null;
  if (!outDir) {
    if (!folderId) {
      throw new Error(
        'Set STORY_OUT_DIR in .env (recommended: a Google Drive for Desktop folder),\n' +
        '  or pass --out=<dir>, or set GOOGLE_DRIVE_FOLDER_ID for API upload.'
      );
    }
    const credentialsPath = getCredentialsPath(__dirname);
    drive = await authenticateDrive(credentialsPath);
    const email = JSON.parse(fs.readFileSync(credentialsPath, 'utf-8')).client_email;
    const folder = await assertFolderWritable(drive, folderId, email);
    console.log(`✓ Drive folder: ${folder.name}`);
  }

  const [image] = await renderPages([buildIntroPage()]);
  console.log('✓ Rendered 1 image');

  const name = 'story-intro.png';
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, name);
    fs.writeFileSync(file, image);
    console.log(`  ${file}`);
  } else {
    const result = await uploadImage(drive, folderId, name, image);
    console.log(`  ${result.replaced ? 'replaced' : 'uploaded'} ${name}`);
  }

  console.log('\n✅ Done');
}

main().catch(error => {
  console.error('\n❌ ' + error.message);
  process.exit(1);
});
