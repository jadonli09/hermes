// Downloads club profile pictures into assets/avatars/.
// Not part of the daily story run: profile pictures change rarely and the daily
// path must cost nothing extra.
//
//   npm run avatars           fetch only clubs with no cached avatar
//   npm run avatars -- --force  refetch everything
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadAccounts } from './config-manager.js';
import { refreshAvatars } from './story/avatars.js';

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const force = process.argv.includes('--force');

if (!process.env.APIFY_TOKEN) {
  console.error('APIFY_TOKEN must be set in .env');
  process.exit(1);
}

const { accounts } = loadAccounts(__dirname);
console.log(`Refreshing avatars for ${accounts.length} account(s)${force ? ' (forced)' : ''}...`);

const { fetched, skipped, missing } = await refreshAvatars(accounts, {
  token: process.env.APIFY_TOKEN,
  force,
  maxTotalChargeUsd: process.env.APIFY_MAX_CHARGE_USD ? parseFloat(process.env.APIFY_MAX_CHARGE_USD) : 5
});

console.log(`\n✓ fetched ${fetched.length}`);
if (skipped.length) console.log(`  ${skipped.length} already cached`);
if (missing.length) console.log(`  ${missing.length} without a profile picture (monogram fallback): ${missing.join(', ')}`);
