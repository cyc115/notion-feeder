import dotenv from 'dotenv';
import { Client, LogLevel } from '@notionhq/client';
import * as fs from 'fs';

dotenv.config();

const {
  NOTION_API_TOKEN,
  NOTION_READER_DATABASE_ID,
  NOTION_FEEDS_DATABASE_ID,
  CI,
} = process.env;
const MAX_PARAGRAPH_LENGTH = 95;

const logLevel = CI ? LogLevel.INFO : LogLevel.DEBUG;
const notion = new Client({
  auth: NOTION_API_TOKEN,
  logLevel,
});

// ensure the filter object has the pattern and field key
function filterHasRequiredKeys(filter) {
  return !!(filter?.field && filter?.pattern);
}

// convert a string pattern to regex
// match all if pattern is empty or is not a valid regex
function patternToRegex(filter) {
  if (filter?.pattern === '') {
    console.error('filter pattern is empty. Return /.*/ instead');
    return /.*/;
  }
  try {
    return new RegExp(filter.pattern, 'i'); // ignore case in pattern
  } catch (err) {
    console.error(err);
    return /.*/;
  }
}

// Return a feed's filter array
// eg.
// [
//     {
//         "field": "Title",
//         "pattern": "(security|privacy|auth)",
//         "regex": /(security|privacy|auth)/
//     },
//     {
//         "field": "Content",
//         "pattern": "(security|privacy|auth)",
//         "regex": /(security|privacy|auth)/
//     }
// ]
export function getFeedItemFilter(feedItem) {
  const filterStr = feedItem.properties.Filter.rich_text[0]?.plain_text || '[]';
  let filters = [];
  try {
    filters = JSON.parse(filterStr);
  } catch (err) {
    console.warn(`Filter string ${filterStr} is invalid json`);
    filters = JSON.parse('[]');
  }
  const validFilters = [];
  for (let i = 0; i < filters.length; i++) {
    if (filterHasRequiredKeys(filters[i])) {
      const filter = filters[i];
      filter.regex = patternToRegex(filter);
      validFilters.push(filter);
    }
  }
  return validFilters;
}

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

  const feeds = response.results.map((feedItem) => ({
    title: feedItem.properties.Title.title[0].plain_text,
    feedUrl: feedItem.properties.Link.url,
    filters: getFeedItemFilter(feedItem),
  }));
  return feeds;
}

// Get a list of existing articles from the reader DB
export async function getExistingArticles() {
  let cursor = undefined;
  let articles = [];

  while (true) {
    const { results, next_cursor } = await notion.databases.query({
      database_id: NOTION_READER_DATABASE_ID,
      start_cursor: cursor,
    });

    articles = articles.concat(
      results.map((article) => {
        let res = undefined;
        try {
          res = {
            title: article.properties.Title.title[0].plain_text,
            url: article.properties.Link.url,
          };
        } catch (err) {
          res = {
            title: article.properties.Link.url,
            url: article.properties.Link.url,
          };
        }
        return res;
      })
    );

    if (!next_cursor) {
      break;
    }
    cursor = next_cursor;
  }
  return articles;
}

// notion only allow a paragraph to have 100 line or less of text.
// compress the lines beyong 95 to one single line if possible
function compressContentIfTooLong(contentArr) {
  if (!Array.isArray(contentArr)) {
    throw new Error('Cannot redact content unless content is an array');
  }

  for (let i = 0; i < contentArr.length; i++) {
    const { paragraph, type } = contentArr[i];
    if (type === 'paragraph') {
      const pLen = paragraph.text.length;
      // check if paragraph is too long
      if (pLen >= MAX_PARAGRAPH_LENGTH) {
        // compress all lines after MAX_PARAGRAPH_LENGTH
        // into this block
        const finalBlock = {
          type: 'text',
          annotations: {
            bold: true,
            strikethrough: false,
            underline: false,
            italic: true,
            code: false,
            color: 'default',
          },
          text: {
            content: 'COMPRESSED: ',
          },
        };
        paragraph.text.slice(MAX_PARAGRAPH_LENGTH).forEach((block) => {
          finalBlock.text.content += block.text.content;
        });

        paragraph.text = [
          ...paragraph.text.slice(0, MAX_PARAGRAPH_LENGTH),
          finalBlock,
        ];
      }
    }
  }

  return contentArr;
}

// each text block need to be less than 2000 characters long
function ensureTextBlockSizeWithinlimit(contentArr) {
  if (!Array.isArray(contentArr)) {
    throw new Error('Cannot redact content unless content is an array');
  }

  for (let i = 0; i < contentArr.length; i++) {
    const { paragraph, type } = contentArr[i];
    if (type === 'paragraph') {
      paragraph.text.forEach((tb) => {
        if (tb.text.content.length >= 2000) {
          tb.text.content = tb.text.content.slice(0, 2000);
        }
      });
    }
  }

  return contentArr;
}

export async function addFeedItemToNotion(notionItem) {
  const { title, link, content } = notionItem;

  console.log(`adding article to Notion: ${title}: ${link}`);
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
      children: ensureTextBlockSizeWithinlimit(
        compressContentIfTooLong(content)
      ),
    });
  } catch (err) {
    console.error(err);
    console.log(`title: ${title}`);
    console.log(`link: ${link}`);
    console.log(`error: ${err.message}`);
  }

  console.log(`added ${title}`);
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
