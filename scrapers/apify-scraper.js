// Apify-backed scraper: reads public Instagram profiles through a managed actor
// instead of driving a logged-in browser. No Instagram account, no credentials,
// and it can run from a datacenter IP (GitHub Actions, cron box, etc).
//
// Shape note: the Playwright backend scrapes one club at a time, but Apify takes
// every username in a single actor run. We therefore fetch once up front and
// serve each club from that cache, which keeps the per-club contract - and every
// caller downstream of it - identical.
import { runActor } from './apify-client.js';
import { isIntroPost } from '../scraper.js';

/**
 * Converts one Apify dataset item into the post shape the pipeline expects.
 * Returns null for items we cannot use.
 */
/**
 * Recovers the profile that was actually requested from the actor's inputUrl,
 * e.g. "https://www.instagram.com/msjwarriors/" -> "msjwarriors".
 */
export function accountFromInputUrl(inputUrl) {
  if (!inputUrl) return null;
  const match = String(inputUrl).match(/instagram\.com\/([^/?#]+)/i);
  return match ? match[1] : null;
}

export function normalizeApifyPost(item) {
  const postUrl = item?.url;
  const timestamp = item?.timestamp;

  if (!postUrl || !timestamp) {
    return null;
  }

  const date = new Date(timestamp);
  if (isNaN(date.getTime())) {
    return null;
  }

  // Carousels expose every slide in `images`; single-image posts only have displayUrl
  const images = Array.isArray(item.images) && item.images.length > 0
    ? item.images
    : [item.displayUrl].filter(Boolean);

  // Attribute to the profile we scraped, not the post's owner. Instagram collab
  // posts appear on a club's grid but are owned by the co-author, and attributing
  // them to the owner would both mis-label the event and drop it entirely - the
  // owner is not an account we asked for, so nothing would ever read that bucket.
  const accountName = accountFromInputUrl(item.inputUrl) || item.ownerUsername || null;

  return {
    postUrl,
    imageUrls: images,
    caption: item.caption || null,
    accountName,
    postDate: date.toISOString().split('T')[0]
  };
}

/**
 * Formats a Date as the actor's onlyPostsNewerThan value (YYYY-MM-DD)
 */
function toActorDate(date) {
  return date.toISOString().split('T')[0];
}

export class ApifyScraper {
  constructor(options = {}) {
    this.token = options.token;
    this.actorId = options.actorId || 'apify/instagram-post-scraper';
    this.resultsLimit = options.resultsLimit || 10;
    this.maxTotalChargeUsd = options.maxTotalChargeUsd;

    // username -> array of normalized posts, populated by prefetch()
    this.postsByAccount = new Map();
    this.prefetched = false;
  }

  /**
   * Fetches posts for every account in one actor run.
   * @param {Array<string>} usernames
   * @param {Date} startDate - Only posts on/after this date are requested
   */
  async prefetch(usernames, startDate) {
    console.log(`\n--- Fetching ${usernames.length} account(s) via Apify (${this.actorId}) ---`);

    const input = {
      username: usernames,
      resultsLimit: this.resultsLimit,
      onlyPostsNewerThan: toActorDate(startDate)
    };

    // Cap billed items at the theoretical maximum this input can return, so a
    // misconfigured resultsLimit cannot run away with the budget
    const maxItems = usernames.length * this.resultsLimit;

    const items = await runActor({
      token: this.token,
      actorId: this.actorId,
      input,
      maxItems,
      maxTotalChargeUsd: this.maxTotalChargeUsd
    });

    let normalized = 0;
    let skipped = 0;

    for (const item of items) {
      const post = normalizeApifyPost(item);

      if (!post || !post.accountName) {
        skipped++;
        continue;
      }

      const key = post.accountName.toLowerCase();
      if (!this.postsByAccount.has(key)) {
        this.postsByAccount.set(key, []);
      }
      this.postsByAccount.get(key).push(post);
      normalized++;
    }

    this.prefetched = true;

    console.log(`✓ Apify returned ${items.length} item(s): ${normalized} usable, ${skipped} unusable`);
    console.log(`✓ Covering ${this.postsByAccount.size}/${usernames.length} requested account(s)`);

    // Accounts the actor returned nothing for. Usually means "no posts in the
    // window", but a typo'd or deleted handle looks exactly the same, so say so.
    const missing = usernames.filter(u => !this.postsByAccount.has(u.toLowerCase()));
    if (missing.length > 0) {
      console.log(`  No posts returned for ${missing.length} account(s): ${missing.join(', ')}`);
    }

    return { totalItems: items.length, accountsCovered: this.postsByAccount.size, missing };
  }

  /**
   * Serves one club's posts from the prefetched cache.
   * Signature matches scraper.js#scrapeClubPosts so callers do not branch.
   *
   * @param {null} _page - Unused; kept so the two backends are interchangeable
   */
  async scrapeClubPosts(_page, clubUsername, startDate, endDate, existingUrls = new Set()) {
    if (!this.prefetched) {
      throw new Error('ApifyScraper.prefetch() must be called before scrapeClubPosts()');
    }

    const posts = this.postsByAccount.get(clubUsername.toLowerCase()) || [];
    const newPosts = [];
    let duplicatesSkipped = 0;
    let dateChecksSkipped = 0;
    let oldestSkipped = null;

    const startDay = Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate());
    const endDay = Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate());

    for (const post of posts) {
      if (existingUrls.has(post.postUrl.trim())) {
        duplicatesSkipped++;
        continue;
      }

      // The actor filters on onlyPostsNewerThan, but it does not apply that to
      // pinned posts and has no upper bound - so re-check both ends locally.
      // Count these: a high number means we are paying for posts we discard.
      const postDay = new Date(post.postDate + 'T00:00:00Z').getTime();
      if (postDay < startDay || postDay > endDay) {
        dateChecksSkipped++;
        if (!oldestSkipped || post.postDate < oldestSkipped) {
          oldestSkipped = post.postDate;
        }
        continue;
      }

      if (isIntroPost(post)) {
        console.log(`  ⏭️  Skipped intro post: ${(post.caption || 'No caption').substring(0, 50)}...`);
        continue;
      }

      newPosts.push(post);
    }

    if (dateChecksSkipped > 0) {
      console.log(
        `  ⏭️  ${dateChecksSkipped} post(s) outside date range (oldest ${oldestSkipped}). ` +
        `Expected for pinned posts, which the actor's onlyPostsNewerThan filter does not apply to.`
      );
    }

    return {
      newPosts,
      stoppedAt: null,        // no scroll loop, so nothing to stop at
      totalScraped: posts.length,
      duplicatesSkipped,
      dateChecksSkipped
    };
  }
}

export function createApifyScraper(options) {
  return new ApifyScraper(options);
}
