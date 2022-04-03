import Parser from 'rss-parser';
import timeDifference from './helpers';
import { getFeedUrlsFromNotion, getExistingArticles } from './notion';
import dotenv from 'dotenv';

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


  return true;
}
export default async function getNewFeedItems() {
  const existingArticles = await getExistingArticles();
  console.log(
    `Number of articles in the reader db: ${existingArticles.length}`
  );

  const feeds = await getFeedUrlsFromNotion();
  let newArticles = [];
  // go through each of the feeds and collect articles in
  for (let i = 0; i < feeds.length; i++) {
    const feed = feeds[i];
    console.log(`Fetching feed items from ${feed.feedUrl}`);
    let feedItems = [];
    try {
      feedItems = await getNewFeedArticlesFrom(
        feed,
        NOTION_FEEDER_BACKFILL_DAYS
      );
      console.log(`number of articles in feed: ${feedItems.length}`);

      feedItems = feedItems.filter((item) => matchFeedFilter(item));
      console.log(
        `number of articles meets the filter requirement: ${feedItems.length}`
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
      console.log(`found dup :${item.link}`);
    } else {
      // Add the current article to dup list
      existingArticles.push({
        url: item.link,
      });
    }

    return !isDup;
  });

  console.log(`Total number of feeds: ${newArticles.length}`);
  return newArticles;
}
