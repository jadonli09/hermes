// Handle verifier: checks whether Instagram usernames actually exist before they
// go into accounts.json. A wrong handle either 404s (silent coverage gap) or
// scrapes a stranger's account into the student calendar, and neither is visible
// in a normal run - so verify first.
//
//   node verify-handles.js msjpolaris msjphotography     # check specific handles
//   node verify-handles.js --unlisted                    # check the unlisted_2026_27 bucket
//   node verify-handles.js --all                         # check every configured account
//
// Requires APIFY_TOKEN. Uses the profile scraper, which bills per profile.
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runActor, acknowledgeActorRun } from './scrapers/apify-client.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_ACTOR = process.env.APIFY_PROFILE_ACTOR_ID || 'apify/instagram-profile-scraper';

function loadAccountsFile() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'accounts.json'), 'utf-8'));
}

function resolveTargets(args) {
  const data = loadAccountsFile();

  // Only enabled categories: --all answers "will my next run work", and disabled
  // accounts are not part of that (and would be billed for nothing)
  if (args.includes('--all')) {
    return Object.values(data.categories)
      .filter(c => Array.isArray(c.accounts) && c.enabled !== false)
      .flatMap(c => c.accounts);
  }

  if (args.includes('--unlisted')) {
    return data.categories.unlisted_2026_27?.accounts || [];
  }

  return args.filter(a => !a.startsWith('--'));
}

async function main() {
  const args = process.argv.slice(2);
  const handles = resolveTargets(args);

  if (handles.length === 0) {
    console.error('Usage: node verify-handles.js <handle...> | --unlisted | --all');
    process.exit(1);
  }

  if (!process.env.APIFY_TOKEN) {
    console.error('APIFY_TOKEN must be set (https://console.apify.com/account/integrations)');
    process.exit(1);
  }

  console.log(`Verifying ${handles.length} handle(s) via ${PROFILE_ACTOR}...\n`);

  const items = await runActor({
    token: process.env.APIFY_TOKEN,
    actorId: PROFILE_ACTOR,
    input: { usernames: handles },
    maxItems: handles.length,
    maxTotalChargeUsd: process.env.APIFY_MAX_CHARGE_USD
      ? parseFloat(process.env.APIFY_MAX_CHARGE_USD)
      : 5
  });

  acknowledgeActorRun(PROFILE_ACTOR, { usernames: handles });

  const found = new Map();
  for (const item of items) {
    if (item?.username) {
      found.set(item.username.toLowerCase(), item);
    }
  }

  const missing = [];
  const stale = [];

  for (const handle of handles) {
    const profile = found.get(handle.toLowerCase());

    if (!profile) {
      missing.push(handle);
      console.log(`✗ @${handle} — not found`);
      continue;
    }

    const posts = profile.postsCount ?? 0;
    const followers = profile.followersCount ?? 0;
    const bio = (profile.biography || '').replace(/\s+/g, ' ').slice(0, 70);
    const flags = [];

    if (profile.private) flags.push('PRIVATE');
    if (posts === 0) flags.push('no posts');
    if (posts > 0 && posts < 5) flags.push('few posts');

    if (flags.length > 0) stale.push(handle);

    console.log(
      `✓ @${handle} — ${posts} posts, ${followers} followers` +
      `${flags.length ? ` [${flags.join(', ')}]` : ''}` +
      `${bio ? `\n    "${bio}"` : ''}`
    );
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Found: ${handles.length - missing.length}/${handles.length}`);

  if (missing.length > 0) {
    console.log(`\nNot found (remove or correct these):\n  ${missing.join('\n  ')}`);
  }
  if (stale.length > 0) {
    console.log(`\nWorth a look (private/empty/near-empty):\n  ${stale.join('\n  ')}`);
  }

  // Non-zero exit when something is wrong, so this is usable in CI
  process.exit(missing.length > 0 ? 1 : 0);
}

main().catch(error => {
  console.error(`\nVerification failed: ${error.message}`);
  process.exit(1);
});
