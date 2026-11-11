export const DEBUG_PAGE_STYLE = `
:root {
  color-scheme: dark;
  --bg: #0f1115;
  --panel: #161a21;
  --panel-2: #1c222b;
  --border: #2a3140;
  --text: #dfe4ec;
  --muted: #8b95a7;
  --accent: #6ea8fe;
  --running: #4ade80;
  --failed: #f87171;
  --cancelled: #fbbf24;
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}
header {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 10px 14px; border-bottom: 1px solid var(--border); background: var(--panel);
  position: sticky; top: 0; z-index: 5;
}
header h1 { font-size: 14px; margin: 0; font-weight: 600; letter-spacing: .3px; }
header .spacer { flex: 1; }
.badge { padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); font-size: 11px; }
.badge.on { color: var(--running); border-color: #245c3c; }
.badge.off { color: var(--failed); border-color: #5c2424; }
.badge.running { color: var(--running); border-color: #245c3c; }
.badge.failed { color: var(--failed); border-color: #5c2424; }
.badge.cancelled { color: var(--cancelled); border-color: #5c4a1f; }
input, button {
  background: var(--panel-2); color: var(--text); border: 1px solid var(--border);
  border-radius: 6px; padding: 5px 8px; font: inherit;
}
button { cursor: pointer; }
button:hover { border-color: var(--accent); }
button.primary { border-color: #31537f; color: var(--accent); }
main { display: grid; grid-template-columns: 340px minmax(0, 1fr); height: calc(100vh - 53px); }
.col { overflow: auto; border-right: 1px solid var(--border); }
.col:last-child { border-right: 0; }
.col h2 {
  margin: 0; padding: 9px 12px; font-size: 11px; color: var(--muted);
  text-transform: uppercase; letter-spacing: .8px; border-bottom: 1px solid var(--border);
  position: sticky; top: 0; background: var(--bg);
}
.item { padding: 8px 12px; border-bottom: 1px solid var(--border); cursor: pointer; }
.item:hover { background: var(--panel); }
.item.active { background: var(--panel-2); border-left: 2px solid var(--accent); }
.item .title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item .meta { color: var(--muted); font-size: 11px; margin-top: 2px; display: flex; gap: 8px; flex-wrap: wrap; }
.dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; background: var(--muted); }
.dot.running { background: var(--running); }
.dot.failed { background: var(--failed); }
.dot.cancelled { background: var(--cancelled); }
.detail { padding: 12px; overflow: auto; }
.detail h3 { margin: 14px 0 6px; font-size: 12px; color: var(--accent); }
.detail h3:first-child { margin-top: 0; }
.kv { display: grid; grid-template-columns: 160px minmax(0, 1fr); gap: 4px 10px; margin-bottom: 10px; }
.kv .k { color: var(--muted); }
.kv .v { overflow-wrap: anywhere; }
details { border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; margin: 6px 0; background: var(--panel); }
details summary { cursor: pointer; color: var(--muted); }
pre {
  margin: 6px 0 0; padding: 8px; border-radius: 6px; background: #0b0d11;
  overflow: auto; max-height: 420px; white-space: pre-wrap; overflow-wrap: anywhere;
}
.toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
.muted { color: var(--muted); }
.empty { padding: 24px 14px; color: var(--muted); }
.err { color: var(--failed); }
.pill { font-size: 11px; padding: 1px 6px; border-radius: 999px; background: var(--panel-2); border: 1px solid var(--border); }
`;
