import getNewFeedItems from './feed';
import {
  addFeedItemToNotion,
  deleteOldUnreadFeedItemsFromNotion,
} from './notion';
import htmlToNotionBlocks from './parser';
import got from 'got'
import read from 'node-readability'

async function getItemContent(item) {
  const data = await got.get(item.link)
  return await getRedableContent(data.body)
}

async function getRedableContent(html) {
  return new Promise((resolve, reject) => {
    read(
      html,
      function(err, article, meta) {
        console.log(err)
        if (err) {
          reject(err)
        } else {
          resolve(article.content)
        }
        article.close();
      })
  })
}

async function index() {
  const feedItems = await getNewFeedItems();

  for (let i = 0; i < feedItems.length; i++) {
    const item = feedItems[i];
    // const content = item['content:encoded'] || item['content']
    const content = await getItemContent(item)
    const notionItem = {
      title: item.title,
      link: item.link,
      content: htmlToNotionBlocks(content),
    };
    await addFeedItemToNotion(notionItem);
  }
  // await deleteOldUnreadFeedItemsFromNotion();
}

index();
