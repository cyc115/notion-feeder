import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeAgainst } from '../src/feed.js';

test('dedupeAgainst drops an article already present in existingUrls', () => {
  const existing = new Set(['https://example.com/a']);
  const result = dedupeAgainst(existing, [
    { title: 'A', link: 'https://example.com/a' },
    { title: 'B', link: 'https://example.com/b' },
  ]);
  assert.deepEqual(
    result.map((a) => a.link),
    ['https://example.com/b']
  );
});

test('dedupeAgainst keeps a new article and adds it to existingUrls', () => {
  const existing = new Set();
  const result = dedupeAgainst(existing, [
    { title: 'New', link: 'https://example.com/new' },
  ]);
  assert.equal(result.length, 1);
  assert.ok(existing.has('https://example.com/new'));
});

test('dedupeAgainst collapses two identical articles in the same batch to one', () => {
  const existing = new Set();
  const result = dedupeAgainst(existing, [
    { title: 'Dup', link: 'https://example.com/dup' },
    { title: 'Dup', link: 'https://example.com/dup' },
  ]);
  assert.equal(result.length, 1);
});

test('dedupeAgainst does not throw on an article with no link', () => {
  const existing = new Set(['https://example.com/a']);
  assert.doesNotThrow(() => {
    dedupeAgainst(existing, [{ title: 'No link', link: undefined }]);
  });
});
