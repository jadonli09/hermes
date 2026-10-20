import { isExistingPost } from '../scraper.js';

test('a post already saved under the short link is recognized from its profile-prefixed link', () => {
  const existing = new Set(['https://www.instagram.com/p/Der6OdBPARq/']);
  expect(isExistingPost(existing, 'https://www.instagram.com/msjfilm/p/Der6OdBPARq/')).toBe(true);
});
test('a post saved under the profile-prefixed link is recognized from the short link', () => {
  const existing = new Set([' https://www.instagram.com/msjfilm/p/Der6OdBPARq/ ']);
  expect(isExistingPost(existing, 'https://www.instagram.com/p/Der6OdBPARq/')).toBe(true);
});
test('a different post is new', () => {
  expect(isExistingPost(new Set(['https://www.instagram.com/p/Der6OdBPARq/']), 'https://www.instagram.com/msjfilm/p/Other/')).toBe(false);
});
