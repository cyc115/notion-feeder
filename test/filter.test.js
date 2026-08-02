import test from 'node:test';
import assert from 'node:assert/strict';
import { matchFeedFilter } from '../src/feed.js';

test('matchFeedFilter matches everything when the feed has no filters', () => {
  const feed = { filters: [] };
  const article = { title: 'anything at all', link: 'https://example.com/a' };
  assert.equal(matchFeedFilter(feed, article), true);
});

test('matchFeedFilter still works without an item.feed property present', () => {
  // Regression pin for the dead `items[0].feed = feed` loop removed in Task 10
  // (feed.js's getNewFeedArticlesFrom): matchFeedFilter takes `feed` as its
  // own argument and never reads article.feed, so filtering must behave
  // identically whether or not that property exists on the article.
  const feed = {
    filters: [{ field: 'title', pattern: 'rust', regex: /rust/i }],
  };
  const articleWithoutFeedProp = { title: 'Learning Rust today', link: 'x' };
  assert.equal('feed' in articleWithoutFeedProp, false);
  assert.equal(matchFeedFilter(feed, articleWithoutFeedProp), true);
});

test('matchFeedFilter rejects an article that matches no filter', () => {
  const feed = {
    filters: [{ field: 'title', pattern: 'rust', regex: /rust/i }],
  };
  const article = { title: 'A post about Python', link: 'x' };
  assert.equal(matchFeedFilter(feed, article), false);
});

test('matchFeedFilter matches if any one filter matches', () => {
  const feed = {
    filters: [
      { field: 'title', pattern: 'rust', regex: /rust/i },
      { field: 'title', pattern: 'python', regex: /python/i },
    ],
  };
  const article = { title: 'A post about Python', link: 'x' };
  assert.equal(matchFeedFilter(feed, article), true);
});
