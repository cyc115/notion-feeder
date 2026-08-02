import dotenv from 'dotenv';
import { Client, LogLevel } from '@notionhq/client';
import * as fs from 'fs';

dotenv.config();

const {
  NOTION_API_TOKEN,
  NOTION_READER_DATABASE_ID,
  NOTION_FEEDS_DATABASE_ID,
  NODE_ENVIRONMENT,
} = process.env;
export const MAX_PARAGRAPH_LENGTH = 95;

// Per-article failures are caught and logged so one bad article doesn't abort
// the whole run, but they must still surface: without this the process always
// exited 0 and a wholly failing run looked green in journalctl.
let failureCount = 0;
export function getFailureCount() {
  return failureCount;
}

const logLevel = NODE_ENVIRONMENT === 'prod' ? LogLevel.INFO : LogLevel.DEBUG;
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

// Get a list of existing articles from the reader DB, bounded to the last
// `sinceDays` days.
//
// Unfiltered, this query pages the ENTIRE reader DB and stops at exactly
// 10,000 rows reporting has_more: false -- a pagination ceiling, not the true
// row count (verified 2026-08-02: a `Created At <= now-30d` filter also
// returns exactly 10,000, while `>= now-14d` returns 434, which cannot both be
// true of the same database unless 10,000 is a ceiling). That silently
// truncates dedup once the DB exceeds it. It also cost 42s and 100 API
// round-trips per run before this fix, 31% of a 137s baseline run.
//
// Only articles inside the backfill window can ever be candidates for
// insertion, so only those need to be in the dedup set -- bounding the query
// fixes both the correctness bug and the cost at once.
export async function getExistingArticles(sinceDays) {
  const since = new Date();
  since.setDate(since.getDate() - sinceDays);

  let cursor;
  let articles = [];

  while (true) {
    const { results, next_cursor } = await notion.databases.query({
      database_id: NOTION_READER_DATABASE_ID,
      start_cursor: cursor,
      filter: {
        property: 'Created At',
        date: {
          on_or_after: since.toISOString(),
        },
      },
    });

    articles = articles.concat(
      results.map((article) => {
        let res;
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

function genTextBlock(message) {
  return {
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
      content: message,
    },
  };
}

// notion only allow a paragraph to have 100 line or less of text.
// compress the lines beyong 95 to one single line if possible
function compressParagraphLineNumber(content) {
  const { paragraph, type } = content;
  if (type === 'paragraph') {
    const pLen = paragraph.rich_text.length;
    // check if paragraph is too long
    if (pLen >= MAX_PARAGRAPH_LENGTH) {
      // compress all lines after MAX_PARAGRAPH_LENGTH into this block
      const finalBlock = genTextBlock('Content truncated:');
      paragraph.rich_text.slice(MAX_PARAGRAPH_LENGTH).forEach((block) => {
        // Same non-text rich_text hazard as truncateParagraph — skip anything
        // that isn't a plain text run rather than dereferencing .text.content.
        if (isTextRun(block)) {
          finalBlock.text.content += block.text.content;
        }
      });

      // Read and write the same field: martian emits `rich_text`, and the
      // Notion API expects it. Writing `paragraph.text` left rich_text
      // uncompressed (so the >100-run limit still tripped) and threw a
      // TypeError reading `paragraph.text.slice` of undefined.
      paragraph.rich_text = [
        ...paragraph.rich_text.slice(0, MAX_PARAGRAPH_LENGTH),
        finalBlock,
      ];
    }
  }
  return content;
}

// return true if content is a paragraph and has undefined text
// This is use to filter out undefined elements
function isParagraphUndefined(content) {
  const { paragraph, type } = content;
  if (type === 'paragraph' && paragraph.rich_text === undefined) {
    console.log(`paragraph undefined: ${JSON.stringify(content)}`);
    return true;
  }
  return false;
}

// Truncate a paragraph to less than 2k char
// A rich_text array is not uniformly text: martian also emits `equation` and
// `mention` entries, which have no `.text` member. Assuming `.text` threw
// "Cannot read properties of undefined (reading 'content')" and lost the whole
// article (3 of 7 items on the first services-VM run).
function isTextRun(tb) {
  return tb && tb.type === 'text' && tb.text && typeof tb.text.content === 'string';
}

function truncateParagraph(content) {
  const { paragraph, type } = content;
  if (type === 'paragraph' && Array.isArray(paragraph?.rich_text)) {
    paragraph.rich_text.forEach((tb) => {
      if (isTextRun(tb) && tb.text.content.length >= 2000) {
        tb.text.content = tb.text.content.slice(0, 2000);
      }
    });
  }
  return content;
}

export async function addFeedItemToNotion(notionItem) {
  try {
    let { title, link, content } = notionItem;
    let sanitizedContentArr = content
      .slice(0, MAX_PARAGRAPH_LENGTH) // remove content longer than 95 lines
      .filter((c) => !isParagraphUndefined(c))
      .map(compressParagraphLineNumber)
      .map(truncateParagraph);

    console.log(`Creating article in Notion: ${title}: ${link}`);

    const createdPage = await notion.pages.create({
      parent: {
        type: 'database_id',
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
      children: sanitizedContentArr,
    });
    console.log(`added ${title}`);

    // Append remaining blocks to the page we just created. Note that
    // blocks.children.append() returns a *list* response ({object: 'list',
    // results: [...]}), not a block — so its `.id` is undefined. Appending to
    // the id of the previous append response therefore failed with
    // `path.block_id should be a valid uuid, instead was "undefined"` on the
    // second and later chunks. Always append to the created page's id.
    const pageId = createdPage.id;
    content = content.slice(MAX_PARAGRAPH_LENGTH);
    while (content.length > 0) {
      sanitizedContentArr = content
        .slice(0, MAX_PARAGRAPH_LENGTH) // remove content longer than 95 lines
        .filter((c) => !isParagraphUndefined(c))
        .map(compressParagraphLineNumber)
        .map(truncateParagraph);
      console.log(`Appending to article: ${title}: ${link}`);
      await notion.blocks.children.append({
        block_id: pageId,
        children: sanitizedContentArr,
      });
      content = content.slice(MAX_PARAGRAPH_LENGTH);
    }
  } catch (err) {
    console.log('========');
    console.error(err);
    console.log(`>> link: ${notionItem.link}`);
    console.log(`>> error message: ${err.message}\n`);
    failureCount += 1;
  }
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
