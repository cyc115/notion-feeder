import got from 'got';
import read from 'node-readability';
import * as Sentry from '@sentry/node';
import * as Tracing from '@sentry/tracing';

import getNewFeedItems from './feed';
import {
  addFeedItemToNotion,
  deleteOldUnreadFeedItemsFromNotion,
} from './notion';
import htmlToNotionBlocks from './parser';

async function getItemContent(item) {
  let readableContent;

  try {
    const data = await got.get(item.link, {
      timeout: {
        request: 6000,
      },
    });

    readableContent = await getRedableContent(data.body);
  } catch (err) {
    console.log(`could not get full text for ${item.link}`);
  }

  // sort based on length and choose the longest one
  return [
    readableContent || '',
    item['content:encoded'] || '',
    item.content || '',
    'page not captured due to error',
  ].reduce((a, b) => (a.length > b.length ? a : b));
}

async function getRedableContent(html) {
  return new Promise((resolve, reject) => {
    read(html, (err, article, meta) => {
      if (err) {
        reject(err);
      } else {
        resolve(article.content);
      }
      article.close();
    });
  });
}

async function index() {
  const feedItems = await getNewFeedItems();

  for (let i = 0; i < feedItems.length; i++) {
    const item = feedItems[i];
    console.log(`before reaching ${item.link}`);
    const content = await getItemContent(item);
    const notionItem = {
      title: item.title,
      link: item.link,
      content: htmlToNotionBlocks(content),
    };
    console.log(`after reaching ${item.link}`);
    await addFeedItemToNotion(notionItem);
  }
}

Sentry.init({
  dsn: 'https://37a0b8c5e20d463f87f9400785956c85@o218963.ingest.sentry.io/6310207',
  tracesSampleRate: 1.0,
});

index();
