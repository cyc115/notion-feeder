import Parser from 'rss-parser';
import dotenv from 'dotenv';
import got from 'got';
import timeDifference from './helpers.js';
import { getFeedUrlsFromNotion, getExistingArticles } from './notion.js';
import { repairXml, looksLikeHtml } from './xml.js';

dotenv.config();

const { NOTION_FEEDER_MAX_ITEMS, NOTION_FEEDER_BACKFILL_DAYS } = process.env;

// Parse a feed. On success this is exactly the call it has always been; the
// diagnosis and repair below are reachable only once a strict parse has already
// failed, so a healthy feed's bytes still reach rss-parser untouched.
//
// Two things happen on failure, in this order:
//
//  1. Say what actually went wrong. A retired feed is almost never a 404 — the
//     publisher 30x's it to a marketing page, rss-parser reads HTML, trips on
//     the first bare `&` in some inline CSS, and reports "Invalid character in
//     entity name". That message sent four days of investigation after the
//     wrong thing. Naming the content type and the URL the redirect landed on
//     turns it into a one-line diagnosis.
//  2. Only then, try repairing genuinely malformed XML. Publishers do ship
//     unescaped ampersands, and losing a real publisher to one stray `&` is
//     worse than the cost of a second fetch.
async function parseFeed(feedUrl) {
  const parser = new Parser();
  try {
    return await parser.parseURL(feedUrl);
  } catch (strictError) {
    let response;
    try {
      response = await got.get(feedUrl, { timeout: { request: 60000 } });
    } catch {
      // The refetch failed too, so the original problem was not the document.
      // Report the parse error the caller actually needs to see.
      throw strictError;
    }

    const raw = response.body;
    const finalUrl = response.url;
    if (looksLikeHtml(response.headers['content-type'], raw)) {
      const via = finalUrl && finalUrl !== feedUrl ? ` (redirected to ${finalUrl})` : '';
      throw new Error(
        `not a feed: served ${response.headers['content-type'] || 'HTML'}${via}` +
          ` — the feed has probably been retired; check for a new URL or disable it`
      );
    }

    const repaired = repairXml(raw);
    if (repaired === raw) {
      // Nothing this knows how to repair. Do not disguise that as some other
      // failure — surface the parser's own complaint.
      throw strictError;
    }

    const parsed = await parser.parseString(repaired);
    console.log(`Repaired malformed XML from ${feedUrl} (unescaped ampersands)`);
    return parsed;
  }
}

async function getNewFeedArticlesFrom(feed, daysToBackfill = 1) {
  const rss = await parseFeed(feed.feedUrl);
  const todaysDate = new Date().getTime() / 1000;

  // only select the articles that more recent than daysToBackfill
  const items = rss.items.filter((item) => {
    const blogPublishedDate = new Date(item.pubDate).getTime() / 1000;
    const { diffInDays } = timeDifference(todaysDate, blogPublishedDate);
    return diffInDays <= daysToBackfill;
  });

  // reverse sort based on date and only take NOTION_FEEDER_MAX_ITEMS
  // per feed
  items.sort((a, b) => new Date(a.pubDate) - new Date(b.pubDate));

  // attach the feed object to each feed article
  for (let i = 0; i < items.length; i++) {
    items[0].feed = feed;
  }

  return items.slice(0, NOTION_FEEDER_MAX_ITEMS);
}

// Drop articles already present in `existingUrls`, and add each newly-kept
// article's URL to the set so duplicates WITHIN a single run are also caught
// (two feeds occasionally syndicate the same story at the same link).
// Mutates `existingUrls`; returns the deduplicated array.
export function dedupeAgainst(existingUrls, articles) {
  return articles.filter((item) => {
    const isDup = existingUrls.has(item.link);
    if (isDup) {
      console.log(`Remove duplicated article: ${item.title}`);
    } else {
      existingUrls.add(item.link);
    }
    return !isDup;
  });
}

// return true if any of the feed filter matches the article
// otherwise return false
function matchFeedFilter(feed, article) {
  const keys = Object.keys(article);
  const feedFilters = feed.filters;

  // if no filter then everything matches
  if (feedFilters.length === 0) {
    return true;
  }

  // else only return the feeds that matches filter
  return feedFilters.some((filter) => {
    const match =
      keys.includes(filter.field) && article[filter.field].match(filter.regex);
    if (match) {
      console.log(
        `Article "${article.title}" matched filter "${filter.field}"`
      );
    }
    return match;
  });
}
export default async function getNewFeedItems() {
  // Margin beyond the backfill window covers clock skew and articles whose
  // pubDate trails their insertion date -- only articles inside this window
  // can ever be dedup candidates, so only those need to be fetched.
  const windowDays = Number(NOTION_FEEDER_BACKFILL_DAYS || 7) + 7;
  const existingArticlesStart = Date.now();
  const existingArticles = await getExistingArticles(windowDays);
  const existingArticlesMs = Date.now() - existingArticlesStart;
  console.log(
    `Found ${existingArticles.length} existing articles in Reader (last ${windowDays}d, ${existingArticlesMs}ms)`
  );

  const feeds = await getFeedUrlsFromNotion();

  // go through each of the feeds to collect articles
  let newArticles = [];
  for (let i = 0; i < feeds.length; i++) {
    const feed = feeds[i];
    console.log(`Fetching from ${feed.feedUrl}`);

    let articles = [];
    try {
      articles = await getNewFeedArticlesFrom(
        feed,
        NOTION_FEEDER_BACKFILL_DAYS
      );
      console.log(`Number of articles in ${feed.feedUrl}: ${articles.length}`);

      articles = articles.filter((item) => matchFeedFilter(feed, item));
      console.log(
        `Number of articles meets the filter requirement: ${articles.length}`
      );
    } catch (err) {
      console.error(`Error fetching ${feed.feedUrl} ${err}`);
      articles = [];
    }
    newArticles = [...newArticles, ...articles];
  }

  // sort feed items by published date
  newArticles.sort((a, b) => new Date(a.pubDate) - new Date(b.pubDate));

  const existingUrls = new Set(existingArticles.map((a) => a.url));
  newArticles = dedupeAgainst(existingUrls, newArticles);

  console.log(`Total new articles: ${newArticles.length}`);
  return newArticles;
}
