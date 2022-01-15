import Parser from 'rss-parser';
import timeDifference from './helpers';
import { getFeedUrlsFromNotion } from './notion';
import dotenv from 'dotenv';

dotenv.config();

const {
  NOTION_FEEDER_MAX_ITEMS,
  NOTION_FEEDER_BACKFILL_YEARS,
} = process.env;


async function getNewFeedItemsFrom(feedUrl) {
  const parser = new Parser();
  const rss = await parser.parseURL(feedUrl);
  const todaysDate = new Date().getTime() / 1000;
  const items = rss.items
        .filter((item) => {
          const blogPublishedDate = new Date(item.pubDate).getTime() / 1000;
          const { diffInDays } = timeDifference(todaysDate, blogPublishedDate);
          return diffInDays <= 356 * NOTION_FEEDER_BACKFILL_YEARS;
        });

  // reverse sort based on date and take NOTION_FEEDER_MAX_ITEMS
  // per feed
  items.sort((a, b) => new Date(a.pubDate) - new Date(b.pubDate))
  return items.slice(0, NOTION_FEEDER_MAX_ITEMS)
}

export default async function getNewFeedItems() {
  let allNewFeedItems = [];

  const feeds = await getFeedUrlsFromNotion();

  for (let i = 0; i < feeds.length; i++) {
    const { feedUrl } = feeds[i];
    console.log(`Fetching feed items from ${feedUrl}`);
    let feedItems = [];
    try {
      feedItems = await getNewFeedItemsFrom(feedUrl);
      console.log(`number of articles: ${feedItems.length}`)
    } catch (err) {
      console.error(`Error fetching ${feedUrl} ${err}`);
      feedItems = [];
    }
    allNewFeedItems = [...allNewFeedItems, ...feedItems];
  }

  // sort feed items by published date
  allNewFeedItems.sort((a, b) => new Date(a.pubDate) - new Date(b.pubDate));

  console.log(`Total number of feeds: ${allNewFeedItems.length}`)
  return allNewFeedItems;
}
