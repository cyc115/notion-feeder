import { markdownToBlocks } from '@tryfabric/martian';
import TurndownService from 'turndown';

export function removeInvalidLinks(line) {
  const invalidLinkRegex = /(.*)\[(.*)]\(#.*\)(.*)/;
  const group = invalidLinkRegex.exec(line);

  // no invalid links
  if (!group) {
    return line;
  }

  const result = group.slice(1).reduce((prev, curr) => prev + curr, '');
  return removeInvalidLinks(result);
}

export function htmlToMarkdown(htmlContent) {
  const turndownService = new TurndownService();
  const md = turndownService.turndown(htmlContent);

  // Notion create page will fail if content contains links to heading, eg.
  // [this is a link](#this-is-a-heading)
  // remove invalid links
  return md.split('\n')
    .map((line) => removeInvalidLinks(line))
    .join('\n');
}

export function markdownToNotionBlocks(markdownContent) {
  const md = markdownContent.split('\n').join('\n');
  return markdownToBlocks(md);
}

export function htmlToNotionBlocks(htmlContent) {
  const markdown = htmlToMarkdown(htmlContent);
  return markdownToNotionBlocks(markdown);
}
