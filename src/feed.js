import Parser from 'rss-parser';
import timeDifference from './helpers';
import { getFeedUrlsFromNotion, getExistingArticles } from './notion';
import dotenv from 'dotenv';

dotenv.config();

const {
  NOTION_FEEDER_MAX_ITEMS,
  NOTION_FEEDER_BACKFILL_DAYS,
} = process.env;


async function getNewFeedItemsFrom(feedUrl, daysToBackfill=1) {
  const parser = new Parser();
  const rss = await parser.parseURL(feedUrl);
  const todaysDate = new Date().getTime() / 1000;
  const items = rss.items
        .filter((item) => {
          const blogPublishedDate = new Date(item.pubDate).getTime() / 1000;
          const { diffInDays } = timeDifference(todaysDate, blogPublishedDate);
          return diffInDays <= daysToBackfill;
        });

  // reverse sort based on date and take NOTION_FEEDER_MAX_ITEMS
  // per feed
  items.sort((a, b) => new Date(a.pubDate) - new Date(b.pubDate))
  return items.slice(0, NOTION_FEEDER_MAX_ITEMS)
}

export default async function getNewFeedItems() {
  let allNewFeedItems = [];

  const feeds = await getFeedUrlsFromNotion();
  const existingArticles = await getExistingArticles();
  console.log(`Number of articles in the reader db: ${existingArticles.length}`)


  for (let i = 0; i < feeds.length; i++) {
    const { feedUrl } = feeds[i];
    console.log(`Fetching feed items from ${feedUrl}`);
    let feedItems = [];
    try {
      feedItems = await getNewFeedItemsFrom(feedUrl, NOTION_FEEDER_BACKFILL_DAYS);
      console.log(`number of articles in feed: ${feedItems.length}`)
    } catch (err) {
      console.error(`Error fetching ${feedUrl} ${err}`);
      feedItems = [];
    }
    allNewFeedItems = [...allNewFeedItems, ...feedItems];
  }

  // sort feed items by published date
  allNewFeedItems.sort((a, b) => new Date(a.pubDate) - new Date(b.pubDate));

  // Do not add items already exist in reader
  allNewFeedItems = allNewFeedItems.filter(item => {
    const isDup = !!existingArticles.find(a => a.url === item.link)
    if (isDup) {
      console.log(`found dup :${item.link}`)
    }
    else {
      // Add the current article to dup list
      existingArticles.push({
        url: item.link
      })
    }

    return !isDup
  })

  console.log(`Total number of feeds: ${allNewFeedItems.length}`)
  return allNewFeedItems;
}
