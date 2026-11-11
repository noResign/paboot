import { DEBUG_PAGE_SCRIPT } from './page-client.js';
import { DEBUG_PAGE_STYLE } from './page-style.js';

/** Single self-contained page: no build step and no external assets. */
export function renderDebugPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>paboot debug</title>
<style>${DEBUG_PAGE_STYLE}</style>
</head>
<body>
<header>
  <h1>paboot · debug</h1>
  <span id="capture" class="badge">capture ?</span>
  <span id="stream" class="badge">offline</span>
  <span id="error" class="err"></span>
  <span class="spacer"></span>
  <input id="token" type="password" placeholder="operator token" autocomplete="off" size="34">
  <button id="save" class="primary">保存</button>
  <button id="clear">清除</button>
  <label class="muted"><input id="follow" type="checkbox" checked> follow live</label>
</header>
<main>
  <section class="col">
    <h2 id="runs-title">runs（实时，进程内）</h2>
    <div id="runs"></div>
    <h2>memory extraction（后台）</h2>
    <div id="memory-list"></div>
  </section>
  <section class="col detail" id="detail"></section>
</main>
<script>${DEBUG_PAGE_SCRIPT}</script>
</body>
</html>`;
}
