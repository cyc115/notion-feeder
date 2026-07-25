import got from 'got';
import read from 'node-readability';

import getNewFeedItems from './feed';
import { addFeedItemToNotion, getFailureCount } from './notion';
import { htmlToNotionBlocks } from './parser';

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

async function index() {
  const feedItems = await getNewFeedItems();

  for (let i = 0; i < feedItems.length; i++) {
    const item = feedItems[i];
    console.log(`Processing ${item.link}`);
    const content = await getItemContent(item);

    const notionItem = {
      title: item.title,
      link: item.link,
      content: htmlToNotionBlocks(content),
    };

    await addFeedItemToNotion(notionItem);
  }

  // Surface per-article failures as a non-zero exit so a failing run is
  // visible in `systemctl status` / `journalctl` instead of silently exiting 0.
  const failures = getFailureCount();
  console.log(
    `Run complete: ${feedItems.length} item(s) processed, ${failures} failed.`
  );
  return failures > 0 ? 1 : 0;
}

index()
  .catch((err) => {
    console.error('Fatal error:', err);
    return 1;
  })
  .then(async (code) => {
    // Exit explicitly. jsdom (via node-readability) and got's keep-alive
    // sockets leave handles open, so the event loop never drains on its own —
    // the process hung indefinitely after finishing its work, which left the
    // container Up and the systemd oneshot stuck in "activating" until
    // TimeoutStartSec. Brief pause first because process.stdout is async when
    // it's a pipe (journald), and process.exit() would truncate the last lines.
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
    process.exit(code);
  });
