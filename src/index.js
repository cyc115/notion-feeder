import getNewFeedItems from './feed';
import {
  addFeedItemToNotion,
  deleteOldUnreadFeedItemsFromNotion,
} from './notion';
import htmlToNotionBlocks from './parser';
import got from 'got'
import read from 'node-readability'

async function getItemContent(item) {
  var readable_content = undefined
  try {
    const data = await got.get(item.link,{
      timeout:{
        request: 6000
      }
    })
    readable_content = await getRedableContent(data.body)
  } catch (err) {
    console.log(`could not get full text for ${item.link}`)
  }

  return readable_content || item['content:encoded'] || item['content'] || 'page not captured due to error'
}

async function getRedableContent(html) {
  return new Promise((resolve, reject) => {
    read(
      html,
      function(err, article, meta) {
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
    console.log(`before reaching ${item.link}`)
    const content = await getItemContent(item)
    const notionItem = {
      title: item.title,
      link: item.link,
      content: htmlToNotionBlocks(content),
    };
    console.log(`after reaching ${item.link}`)
    await addFeedItemToNotion(notionItem);
  }
  // await deleteOldUnreadFeedItemsFromNotion();
}

index();
