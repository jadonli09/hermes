// Apify-backed scraper: reads public Instagram profiles through a managed actor
// instead of driving a logged-in browser. No Instagram account, no credentials,
// and it can run from a datacenter IP (GitHub Actions, cron box, etc).
//
// Shape note: the Playwright backend scrapes one club at a time, but Apify takes
// every username in a single actor run. We therefore fetch once up front and
// serve each club from that cache, which keeps the per-club contract - and every
// caller downstream of it - identical.
import { classifyCoverage } from '../automation/coverage.js';
import { emit } from '../utils/progress-events.js';
import { canonicalPostUrl } from '../automation/state.js';
import { runActor, acknowledgeActorRun } from './apify-client.js';
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
    postUrl: canonicalPostUrl(postUrl),
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
      onlyPostsNewerThan: process.env.HERMES_FETCH_SINCE || toActorDate(startDate),

      // Pinned posts are returned like any other post and count against
      // resultsLimit, and onlyPostsNewerThan is documented as not applying to
      // them - so a club with three pinned posts from two years ago would spend
      // three of its ten slots on items we then discard locally, every run.
      // Dropping them actor-side means we pay for ten real posts instead.
      skipPinnedPosts: true
    };

    this.lastInput = input;

    // Cap billed items at the theoretical maximum this input can return, so a
    // misconfigured resultsLimit cannot run away with the budget
    const maxItems = usernames.length * this.resultsLimit;

    const items = await runActor({
      token: this.token,
      actorId: this.actorId,
      input,
      maxItems,
      maxTotalChargeUsd: this.maxTotalChargeUsd,
      onDiagnostics: value => { this.actorDiagnostics = value; }
    });
    this.coverage = classifyCoverage(items, usernames, this.resultsLimit, this.actorDiagnostics);
    emit('coverage', { report: this.coverage });

    if (process.env.HERMES_STRICT_REFRESH === 'true' && items.some(item => item?.error || item?.errorDescription)) {
      throw new Error('Apify returned account errors; refusing incomplete refresh');
    }
    this.postsByAccount.clear();
    const seen = new Set();
    const dayCounts = new Map();
    let normalized = 0;
    let skipped = 0;

    for (const item of items) {
      const post = item?.error || item?.errorDescription ? null : normalizeApifyPost(item);

      if (!post || !post.accountName) {
        skipped++;
        continue;
      }

      const key = post.accountName.toLowerCase();
      const identity = `${key}:${post.postUrl}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(item.timestamp));
      const dayKey = `${key}:${day}`;
      dayCounts.set(dayKey, (dayCounts.get(dayKey) || 0) + 1);
      if (!this.postsByAccount.has(key)) {
        this.postsByAccount.set(key, []);
      }
      this.postsByAccount.get(key).push(post);
      normalized++;
    }

    if (process.env.HERMES_STRICT_REFRESH === 'true') {
      if (skipped) throw new Error('Apify returned unusable rows; refusing incomplete refresh');
      if ([...this.postsByAccount.values()].some(posts => posts.length > this.resultsLimit)) throw new Error('Actor exceeded requested per-profile cap; review coverage');
      const saturated = [...this.postsByAccount].filter(([, posts]) => posts.length === this.resultsLimit).map(([name]) => name);
      if (saturated.length) {
        console.warn(`Coverage relies on the configured one-post-per-day assumption for ${saturated.length} capped account(s); no automatic paid expansion`);
        emit('coverage', { assumedDailyLimit: 1, cappedAccounts: saturated, completenessVerified: false });
      }
    }
    this.prefetched = true;
    if (!this.coverage.complete) console.warn(`Coverage incomplete: ${Object.values(this.coverage.accounts).filter(x=>!x.complete).length}/${usernames.length} accounts have gaps; valid posts remain usable in best-effort mode.`);

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
  acknowledge() {
    if (this.lastInput) acknowledgeActorRun(this.actorId, this.lastInput);
  }

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

    const known = new Set([...existingUrls].map(canonicalPostUrl));
    for (const post of posts) {
      if (known.has(canonicalPostUrl(post.postUrl))) {
        duplicatesSkipped++;
        continue;
      }

      // onlyPostsNewerThan has no upper bound, and skipPinnedPosts is the actor
      // honouring a request we cannot verify - so re-check both ends locally
      // rather than trusting the filter. Count these: anything above zero means
      // we are paying for posts we discard.
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
        `We ask the actor to skip pinned posts and filter by date, so this should be rare - ` +
        `a persistent count means we are being billed for posts we throw away.`
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
