import Parser from 'rss-parser';
import timeDifference from './helpers';
import { getFeedUrlsFromNotion } from './notion';

async function getNewFeedItemsFrom(feedUrl) {
  const parser = new Parser();
  const rss = await parser.parseURL(feedUrl);
  const todaysDate = new Date().getTime() / 1000;
  return rss.items.filter((item) => {
    const blogPublishedDate = new Date(item.pubDate).getTime() / 1000;
    const { diffInDays } = timeDifference(todaysDate, blogPublishedDate);
    return diffInDays === 0;
  });
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
      console.log(`item length: ${feedItems.length}`)
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
