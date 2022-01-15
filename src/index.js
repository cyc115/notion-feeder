import getNewFeedItems from './feed';
import {
  addFeedItemToNotion,
  deleteOldUnreadFeedItemsFromNotion,
} from './notion';
import htmlToNotionBlocks from './parser';

async function index() {
  const feedItems = await getNewFeedItems();

  for (let i = 0; i < feedItems.length; i++) {
    const item = feedItems[i];
    const content = item['content:encoded'] || item['content']
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
