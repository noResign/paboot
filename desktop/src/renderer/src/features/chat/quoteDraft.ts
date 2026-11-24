export interface Quote {
  author: string | null;
  text: string;
}

/**
 * The prompt prefix for a quoted message.
 *
 * The daemon only receives prompt text, so the quote is part of it — which is
 * also why it shows in the user's own bubble. It must be a blockquote (`>`)
 * line: both the composer's mention matcher and the daemon's strip quoted text,
 * so an `@name` inside the quoted words cannot address anyone.
 */
export function quoteBlock(quote: Quote): string {
  const snippet = quote.text.replace(/\s+/g, ' ').trim().slice(0, 180);
  return `> 引用${quote.author ? ` ${quote.author}` : ''}：${snippet}`;
}
