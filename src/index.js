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
  const readable_content = await getRedableContent(data.body)
  return readable_content || item['content:encoded'] || item['content'] || 'page not captured due to error'
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
