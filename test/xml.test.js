import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeBareAmpersands, looksLikeHtml } from '../src/xml.js';

test('escapeBareAmpersands leaves valid entities untouched', () => {
  for (const s of [
    'a &amp; b',
    '&lt;x&gt;',
    "it&#8217;s",
    "it&#x2019;s",
    'a&nbsp;b',
    '&foo.bar-baz;',
  ]) {
    assert.equal(escapeBareAmpersands(s), s);
  }
});

test('escapeBareAmpersands repairs real-world bare ampersands', () => {
  assert.equal(escapeBareAmpersands('analyses, & other'), 'analyses, &amp; other');
  assert.equal(escapeBareAmpersands('?a=1&display=swap'), '?a=1&amp;display=swap');
  assert.equal(escapeBareAmpersands('x&&y'), 'x&amp;&amp;y');
  assert.equal(escapeBareAmpersands('ends with &'), 'ends with &amp;');
});

test('escapeBareAmpersands is idempotent', () => {
  assert.equal(
    escapeBareAmpersands(escapeBareAmpersands('a & b')),
    'a &amp; b'
  );
});

test('looksLikeHtml detects HTML by content-type and by body', () => {
  assert.equal(looksLikeHtml('text/html; charset=utf-8', '<rss>'), true);
  assert.equal(looksLikeHtml('', '<!DOCTYPE html>\n<html>'), true);
  assert.equal(looksLikeHtml(undefined, '  <html lang="en">'), true);
});

test('looksLikeHtml does not misclassify feeds', () => {
  assert.equal(
    looksLikeHtml('application/rss+xml', '<?xml version="1.0"?><rss>'),
    false
  );
  assert.equal(looksLikeHtml('application/atom+xml', '<feed xmlns="x">'), false);
  assert.equal(
    looksLikeHtml('application/xml', '<?xml?><rss><title>html tips</title>'),
    false
  );
  assert.equal(looksLikeHtml('', ''), false);
});
