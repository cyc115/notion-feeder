import { markdownToBlocks } from '@tryfabric/martian';
import TurndownService from 'turndown';

// remove non-URI links because Notion create page will fail
// if content contains links to heading, eg. [this is a link](#this-is-a-heading)
export function fixRemoveInvalidLinks(line) {
  const invalidLinkRegex = /(.*)\[(.*)]\(((?!http).)*\)(.*)/;
  const group = invalidLinkRegex.exec(line);

  // remove invalid links
  if (!group) {
    return line;
  }

  const result = group.slice(1).reduce((prev, curr) => prev + curr, '');
  return fixRemoveInvalidLinks(result);
}

export function htmlToMarkdown(htmlContent) {
  const turndownService = new TurndownService();
  let md = turndownService.turndown(htmlContent);

  // Notion API has a lot of quirks...
  // Apply transformation to mardown to improve page result
  md = md
    .split('\n')
    .map((line) => fixRemoveInvalidLinks(line))
    .join('\n');

  return md;
}

export function htmlToNotionBlocks(htmlContent) {
  const markdown = htmlToMarkdown(htmlContent);
  const blocks = markdownToBlocks(markdown);
  return blocks;
}
