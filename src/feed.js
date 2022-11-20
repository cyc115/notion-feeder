import Parser from 'rss-parser';
import dotenv from 'dotenv';
import timeDifference from './helpers';
import { getFeedUrlsFromNotion, getExistingArticles } from './notion';

dotenv.config();

const { NOTION_FEEDER_MAX_ITEMS, NOTION_FEEDER_BACKFILL_DAYS } = process.env;

async function getNewFeedArticlesFrom(feed, daysToBackfill = 1) {
  const parser = new Parser();
  const rss = await parser.parseURL(feed.feedUrl);
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
  const existingArticles = await getExistingArticles();
  console.log(`${existingArticles.length} existing articles in reader`);

  const feeds = await getFeedUrlsFromNotion();
  let newArticles = [];

  // go through each of the feeds to collect articles
  for (let i = 0; i < feeds.length; i++) {
    const feed = feeds[i];
    console.log(`Fetching from ${feed.feedUrl}`);

    let feedItems = [];
    try {
      feedItems = await getNewFeedArticlesFrom(
        feed,
        NOTION_FEEDER_BACKFILL_DAYS
      );
      console.log(`Number of articles in ${feed.feedUrl}: ${feedItems.length}`);

      feedItems = feedItems.filter((item) => matchFeedFilter(feed, item));
      console.log(
        `Number of articles meets the filter requirement: ${feedItems.length}`
      );
    } catch (err) {
      console.error(`Error fetching ${feed.feedUrl} ${err}`);
      feedItems = [];
    }
    newArticles = [...newArticles, ...feedItems];
  }

  // sort feed items by published date
  newArticles.sort((a, b) => new Date(a.pubDate) - new Date(b.pubDate));

  // Do not add items already in existingArticles
  newArticles = newArticles.filter((item) => {
    const isDup = !!existingArticles.find((a) => a.url === item.link);
    if (isDup) {
      console.log(`Remove duplicated article: ${item.title}`);
    } else {
      // Add the current article to dup list
      existingArticles.push({
        url: item.link,
      });
    }

    return !isDup;
  });

  console.log(`Total new articles: ${newArticles.length}`);
  return newArticles;
}
