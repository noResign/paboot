import TurndownService from 'turndown';
import { gfm } from '@joplin/turndown-plugin-gfm';

import { WebFetchError } from './fetch.js';

/**
 * HTML → Markdown for the local fetch backend.
 *
 * The daemon has no browser DOM, so conversion needs two things: a server-side
 * DOM (turndown pulls in `@mixmark-io/domino` as its only dependency) and the
 * GFM plugin, because plain turndown degrades tables and task lists into prose.
 */

/**
 * Nesting depth above which conversion is refused.
 *
 * Conversion walks the DOM synchronously on the event loop, and unclosed-tag
 * nesting makes that walk superlinear — measured in the harness this ports
 * from: depth 512 ≈ 0.15s, 2,000 ≈ 2s, 20,000 ≈ 5s. While it runs, timers
 * cannot fire, so the fetch timeout is not a backstop here. Real pages nest a
 * few dozen levels; this is a robustness invariant, not a tunable.
 */
export const MAX_CONVERSION_DEPTH = 512;

/**
 * Source characters fed to the converter. Conversion is synchronous, so a
 * multi-megabyte page would block the loop even at shallow depth.
 */
export const MAX_CONVERSION_CHARS = 200_000;

/** Elements that never take a closing tag, so they do not grow the stack. */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** Elements whose contents the HTML parser reads as text until the end tag. */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'noscript']);

/**
 * One converter for the whole process. `turndown()` is stateless, so sharing
 * the instance is safe and avoids rebuilding the rule set per fetch.
 *
 * Options are fixed presentation, matching the repo's markdown conventions:
 * ATX headings, fenced code, `-` bullets.
 */
const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});
turndown.use(gfm);
// Non-content elements are dropped wholesale: turndown's default keeps the text
// of `<script>` / `<style>`, which is exactly what should not reach the model.
turndown.addRule('removeNonVisibleContent', {
  filter(node) {
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED'].includes(node.nodeName)) {
      return true;
    }
    if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden')?.toLowerCase() === 'true') {
      return true;
    }
    if (node.nodeName === 'INPUT' && node.getAttribute('type')?.toLowerCase() === 'hidden') {
      return true;
    }
    const declarations: string[] = node.getAttribute('style')?.split(';') ?? [];
    return declarations.some((declaration: string) => {
      const separator = declaration.indexOf(':');
      if (separator === -1) return false;
      const property = declaration.slice(0, separator).trim().toLowerCase();
      const value = declaration
        .slice(separator + 1)
        .trim()
        .toLowerCase()
        .replace(/\s*!important\s*$/u, '');
      return (
        (property === 'display' && value === 'none') ||
        (property === 'visibility' && (value === 'hidden' || value === 'collapse'))
      );
    });
  },
  replacement() {
    return '';
  },
});

/** Whether a character can follow a raw-text end-tag name. */
function isTagBoundary(char: string | undefined): boolean {
  return char === undefined || char === '>' || char === '/' || /\s/.test(char);
}

/** Find the matching raw-text end tag without interpreting markup-like body text. */
function findRawTextEnd(lowerHtml: string, name: string, from: number): number {
  const prefix = `</${name}`;
  let candidate = lowerHtml.indexOf(prefix, from);
  while (candidate !== -1 && !isTagBoundary(lowerHtml[candidate + prefix.length])) {
    candidate = lowerHtml.indexOf(prefix, candidate + prefix.length);
  }
  return candidate;
}

/**
 * Whether the HTML's element stack crosses `maxDepth`.
 *
 * A single conservative pass: closing tags inside comments are ignored,
 * raw-text bodies are skipped, quoted `>` characters do not end a tag, and a
 * closing tag only pops when it matches the current element — malformed input
 * therefore over-counts rather than hiding nesting.
 */
export function exceedsConversionDepth(
  html: string,
  maxDepth = MAX_CONVERSION_DEPTH,
): boolean {
  const lowerHtml = html.toLowerCase();
  const openElements: string[] = [];
  let offset = 0;
  let inComment = false;

  while (offset < html.length) {
    // Comment bodies are text, not markup: skip them wholesale. An unterminated
    // comment swallows the rest of the document for a real parser too, so
    // stopping there cannot hide nesting behind it.
    if (inComment) {
      const end = html.indexOf('-->', offset);
      if (end === -1) break;
      inComment = false;
      offset = end + 3;
      continue;
    }

    const start = html.indexOf('<', offset);
    if (start === -1) break;
    if (html.startsWith('<!--', start)) {
      inComment = true;
      offset = start + 4;
      continue;
    }

    let cursor = start + 1;
    const closing = html[cursor] === '/';
    if (closing) cursor += 1;
    const nameStart = cursor;
    while (/[a-zA-Z0-9-]/.test(html[cursor] ?? '')) cursor += 1;
    if (cursor === nameStart || !/[a-zA-Z]/.test(html.charAt(nameStart))) {
      offset = start + 1;
      continue;
    }

    const name = lowerHtml.slice(nameStart, cursor);
    let quote: '"' | "'" | undefined;
    while (cursor < html.length) {
      const char = html[cursor];
      cursor += 1;
      if (quote !== undefined) {
        if (char === quote) quote = undefined;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '>') {
        break;
      }
    }
    if (html[cursor - 1] !== '>') break;

    if (closing) {
      if (openElements.at(-1) === name) openElements.pop();
    } else {
      // `<div />` is self-closing; `<div>` is not.
      let last = cursor - 2;
      while (/\s/.test(html.charAt(last))) last -= 1;
      if (!VOID_ELEMENTS.has(name) && html[last] !== '/') {
        openElements.push(name);
        if (openElements.length > maxDepth) return true;
        if (RAW_TEXT_ELEMENTS.has(name)) {
          const end = findRawTextEnd(lowerHtml, name, cursor);
          if (end === -1) break;
          offset = end;
          continue;
        }
      }
    }
    offset = cursor;
  }
  return false;
}

export interface ConvertedHtml {
  text: string;
  /** True when the source was cut to bound synchronous conversion work. */
  truncated: boolean;
}

/**
 * Convert an HTML body to Markdown.
 *
 * Throws instead of returning the raw markup when conversion is unsafe: a
 * partial or unconverted body would hand the model thousands of tokens of
 * markup as if it were prose, and the tool result already has a channel for
 * "this fetch failed".
 */
export function convertHtmlToMarkdown(
  html: string,
  options: { maxChars?: number; maxDepth?: number } = {},
): ConvertedHtml {
  const maxChars = options.maxChars ?? MAX_CONVERSION_CHARS;
  const maxDepth = options.maxDepth ?? MAX_CONVERSION_DEPTH;
  const source = html.length > maxChars ? html.slice(0, maxChars) : html;
  const truncated = source.length !== html.length;

  if (exceedsConversionDepth(source, maxDepth)) {
    throw new WebFetchError(
      `HTML nests deeper than ${maxDepth} levels; refusing to convert it synchronously. ` +
        'Try the provider-hosted backend for this page',
    );
  }
  try {
    return { text: turndown.turndown(source), truncated };
  } catch (error) {
    // turndown recurses per element, so malformed markup the lexical guard
    // cannot model can still blow the stack.
    throw new WebFetchError(
      `HTML could not be converted: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
