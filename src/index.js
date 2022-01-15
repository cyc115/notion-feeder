import getNewFeedItems from './feed';
import {
  addFeedItemToNotion,
  deleteOldUnreadFeedItemsFromNotion,
} from './notion';
import htmlToNotionBlocks from './parser';
import read from 'node-readability'

async function getReadableContent(item) {
  return new Promise((resolve, reject) => {
    // read(item.link,  function(err, article, meta) {
    read(
      // "https://tldrsec.com/blog/tldr-sec-115/",
      "http://colorlines.com/archives/2011/08/dispatch_from_angola_faith-based_slavery_in_a_louisiana_prison.html",
      // {
      //   strictSSL: true,
      //   agent: agent,
      // },
      function(err, article, meta) {
      console.log(err)
      if (err) {
        reject(err)
      } else {
        resolve(article.content)
      }
      // Close article to clean up jsdom and prevent leaks
      article.close();
    })
  })
  // return item["content"]
}

async function index() {
  const feedItems = await getNewFeedItems();

  for (let i = 0; i < feedItems.length; i++) {
    const item = feedItems[i];
    const content = item['content:encoded'] || await getReadableContent(item)
    // const content = await getReadableContent(item)
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
