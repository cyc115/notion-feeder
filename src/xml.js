// Repairs for feeds that serve XML which is not well-formed.
//
// Publishers get this wrong often enough that a strict parser alone loses real
// content. research.nccgroup.com, for example, serves 30 bare ampersands in a
// single document ("public reports, technical advisories, analyses, & other
// novel insights", plus unescaped query strings inside embedded HTML). Python's
// ElementTree rejects it too, so this is genuinely malformed XML rather than an
// rss-parser quirk — but the feed is otherwise perfectly readable.

// An ampersand legitimately starts an entity reference: a named one (&amp;),
// a decimal numeric one (&#8217;), or a hex one (&#x2019;). Anything else is a
// literal ampersand the publisher forgot to escape.
//
// Name characters follow the XML spec's Name production (letters, digits, and
// `.`, `-`, `_`, `:`) so that valid-but-unusual entities are left alone. The
// terminating `;` is required: `&display=swap` inside a stylesheet URL looks
// like the start of an entity for five characters and then is not one.
const BARE_AMPERSAND =
  /&(?!(?:[A-Za-z_:][A-Za-z0-9._:-]*|#[0-9]+|#[xX][0-9A-Fa-f]+);)/g;

export function escapeBareAmpersands(xml) {
  return xml.replace(BARE_AMPERSAND, '&amp;');
}

// Applied only after a strict parse has already failed, never pre-emptively:
// a well-formed feed must reach the parser byte-for-byte as published.
export function repairXml(xml) {
  return escapeBareAmpersands(xml);
}

// A feed URL that has quietly become a web page is the single most common way
// a feed dies, and it is the case the raw parser reports worst. When a
// publisher retires a feed they rarely 404 it; they 30x it to a marketing page.
// The parser then reads HTML, hits the first bare `&` in some inline CSS, and
// reports "Invalid character in entity name" — which reads like a malformed
// feed and sends you looking in entirely the wrong place. It cost four days of
// misdiagnosis on research.nccgroup.com, which 307s to nccgroup.com/research/.
export function looksLikeHtml(contentType, body) {
  if (/\btext\/html\b/i.test(contentType || '')) {
    return true;
  }
  return /^\s*(?:<!doctype\s+html|<html[\s>])/i.test((body || '').slice(0, 512));
}
