// Club profile pictures for the story graphic.
//
// Instagram CDN URLs are signed and expire, so images are downloaded and cached
// on disk rather than referenced live. Profile pictures change rarely, so the
// refresh is an explicit command and never runs on the daily path.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runActor, acknowledgeActorRun } from '../scrapers/apify-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const AVATAR_DIR = path.join(__dirname, '..', 'assets', 'avatars');

const PROFILE_ACTOR = process.env.APIFY_PROFILE_ACTOR_ID || 'apify/instagram-profile-scraper';

/**
 * Initial shown when a club has no profile picture. Strips the msj prefix so
 * "msjdatascience" reads as D rather than M, which would be the same letter for
 * nearly every club.
 * @param {string} handle
 * @returns {string}
 */
export function monogram(handle) {
  const name = String(handle || '').replace(/^msj[._-]?/i, '');
  return (name || String(handle || '?')).charAt(0).toUpperCase();
}

/**
 * Absolute path to a club's cached avatar, or null when none is cached.
 * @param {string} handle
 * @param {string} [dir]
 * @returns {string|null}
 */
export function avatarPath(handle, dir = AVATAR_DIR) {
  const file = path.join(dir, `${handle}.jpg`);
  return fs.existsSync(file) ? file : null;
}

/**
 * Downloads and caches profile pictures.
 *
 * @param {Array<string>} handles
 * @param {Object} options
 * @param {string} options.token - Apify token
 * @param {boolean} [options.force] - Refetch handles that are already cached
 * @param {number} [options.maxTotalChargeUsd]
 * @param {string} [options.dir]
 * @returns {Promise<{fetched: string[], skipped: string[], missing: string[]}>}
 */
export async function refreshAvatars(handles, { token, force = false, maxTotalChargeUsd = 5, dir = AVATAR_DIR } = {}) {
  fs.mkdirSync(dir, { recursive: true });

  const wanted = force ? handles : handles.filter(h => !avatarPath(h, dir));
  const skipped = handles.filter(h => !wanted.includes(h));

  if (wanted.length === 0) {
    return { fetched: [], skipped, missing: [] };
  }

  const profiles = await runActor({
    token,
    actorId: PROFILE_ACTOR,
    input: { usernames: wanted },
    maxItems: wanted.length,
    maxTotalChargeUsd
  });

  acknowledgeActorRun(PROFILE_ACTOR, { usernames: wanted });

  const fetched = [];
  for (const profile of profiles) {
    const handle = profile?.username;
    const url = profile?.profilePicUrlHD || profile?.profilePicUrl;
    if (!handle || !url) continue;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        console.warn(`  avatar ${handle}: HTTP ${response.status}`);
        continue;
      }
      fs.writeFileSync(path.join(dir, `${handle}.jpg`), Buffer.from(await response.arrayBuffer()));
      fetched.push(handle);
    } catch (error) {
      console.warn(`  avatar ${handle}: ${error.message}`);
    }
  }

  // Clubs with no picture at all are normal, not an error - they render a
  // monogram instead. Report them so a systemic failure is still visible.
  const missing = wanted.filter(h => !fetched.includes(h));
  return { fetched, skipped, missing };
}
