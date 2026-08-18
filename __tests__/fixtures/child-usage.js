// A scrape that reports Claude token usage and a summary, then a story-style
// finish, so the runner's history folding can be checked in one child.
import fs from 'fs';

fs.writeSync(3, JSON.stringify({ t: 'claude:usage', model: 'claude-haiku-4-5', inputTokens: 100, outputTokens: 10 }) + '\n');
fs.writeSync(3, JSON.stringify({ t: 'claude:usage', model: 'claude-haiku-4-5', inputTokens: 50, outputTokens: 5, cacheReadTokens: 7 }) + '\n');
fs.writeSync(3, JSON.stringify({ t: 'claude:usage', model: 'claude-sonnet-5', inputTokens: 900, outputTokens: 90 }) + '\n');
fs.writeSync(3, JSON.stringify({ t: 'summary', summary: { clubsProcessed: 2, totalPostsScraped: 5, totalNewPostsAdded: 3 } }) + '\n');
fs.writeSync(3, JSON.stringify({ t: 'story:done', date: '2026-08-17', pages: 2, files: ['story-2026-08-17-p1.png', 'story-2026-08-17-p2.png'] }) + '\n');
process.exit(0);
