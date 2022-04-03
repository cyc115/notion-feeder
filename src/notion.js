import dotenv from 'dotenv';
import { Client, LogLevel } from '@notionhq/client';

dotenv.config();

const {
  NOTION_API_TOKEN,
  NOTION_READER_DATABASE_ID,
  NOTION_FEEDS_DATABASE_ID,
  CI,
} = process.env;

const logLevel = CI ? LogLevel.INFO : LogLevel.DEBUG;
const notion = new Client({
  auth: NOTION_API_TOKEN,
  logLevel,
});

export async function getFeedUrlsFromNotion() {
  let response;
  try {
    response = await notion.databases.query({
      database_id: NOTION_FEEDS_DATABASE_ID,
      filter: {
        or: [
          {
            property: 'Enabled',
            checkbox: {
              equals: true,
            },
          },
        ],
      },
    });
  } catch (err) {
    console.error(err);
    return [];
  }

  const feeds = response.results.map((item) => ({
    title: item.properties.Title.title[0].plain_text,
    feedUrl: item.properties.Link.url,
  }));

  return feeds;
}

// Get a list of existing articles from the reader DB
export async function getExistingArticles() {
  let cursor = undefined
  let articles = []

  while (true) {
    let {results, next_cursor} = await notion.databases.query({
      database_id: NOTION_READER_DATABASE_ID,
      start_cursor: cursor,
    });

    articles = articles.concat(
      results.map((article) => {
        let res = undefined
        try {
          res = {
            title: article.properties.Title.title[0].plain_text,
            url: article.properties.Link.url,
          }
        } catch (err) {
          res = {
            title: article.properties.Link.url,
            url: article.properties.Link.url,
          }
        }
        return res
      }))

    if(!next_cursor) {
      break
    }
    cursor = next_cursor
  }
  return articles;
}

export async function addFeedItemToNotion(notionItem) {
  const { title, link, content } = notionItem;

  console.log(`adding article to Notion: ${title}: ${link}`)
  const notion = new Client({
    auth: NOTION_API_TOKEN,
    logLevel,
  });

  try {
    await notion.pages.create({
      parent: {
        database_id: NOTION_READER_DATABASE_ID,
      },
      properties: {
        Title: {
          title: [
            {
              text: {
                content: title,
              },
            },
          ],
        },
        Link: {
          url: link,
        },
      },
      children: content,
    });
  } catch (err) {
    console.error(err);
  }

  console.log(`added ${title}`)
}

export async function deleteOldUnreadFeedItemsFromNotion() {
  // Create a datetime which is 30 days earlier than the current time
  const fetchBeforeDate = new Date();
  fetchBeforeDate.setDate(fetchBeforeDate.getDate() - 30);

  // Query the feed reader database
  // and fetch only those items that are unread or created before last 30 days
  let response;
  try {
    response = await notion.databases.query({
      database_id: NOTION_READER_DATABASE_ID,
      filter: {
        and: [
          {
            property: 'Created At',
            date: {
              on_or_before: fetchBeforeDate.toJSON(),
            },
          },
          {
            property: 'Read',
            checkbox: {
              equals: false,
            },
          },
        ],
      },
    });
  } catch (err) {
    console.error(err);
    return;
  }

  // Get the page IDs from the response
  const feedItemsIds = response.results.map((item) => item.id);

  for (let i = 0; i < feedItemsIds.length; i++) {
    const id = feedItemsIds[i];
    try {
      await notion.pages.update({
        page_id: id,
        archived: true,
      });
    } catch (err) {
      console.error(err);
    }
  }
}
