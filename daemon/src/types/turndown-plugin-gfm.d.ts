/**
 * `@joplin/turndown-plugin-gfm` ships no type declarations (v1.0.71). Only the
 * plugin functions are declared; they are all `TurndownService.Plugin`.
 */
declare module '@joplin/turndown-plugin-gfm' {
  import TurndownService = require('turndown');

  /** Tables, strikethrough and task lists in one plugin. */
  export const gfm: TurndownService.Plugin;
  export const tables: TurndownService.Plugin;
  export const strikethrough: TurndownService.Plugin;
  export const taskListItems: TurndownService.Plugin;
  export const highlightedCodeBlock: TurndownService.Plugin;
}
