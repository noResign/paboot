import { describe, expect, it } from 'vitest';

import { WebFetchError } from '../src/runtimes/builtin/web/fetch';
import {
  MAX_CONVERSION_DEPTH,
  convertHtmlToMarkdown,
  exceedsConversionDepth,
} from '../src/runtimes/builtin/web/html';

describe('HTML → Markdown conversion', () => {
  it('converts headings, emphasis, lists and links', () => {
    const { text } = convertHtmlToMarkdown(
      '<h1>标题</h1><p>这是<strong>重点</strong>和<em>斜体</em></p><ul><li>甲</li><li>乙</li></ul>' +
        '<a href="https://example.com">链接</a>',
    );
    expect(text).toContain('# 标题');
    expect(text).toContain('**重点**');
    expect(text).toContain('-   甲');
    expect(text).toContain('[链接](https://example.com)');
  });

  it('keeps GFM tables instead of flattening them into prose', () => {
    const { text } = convertHtmlToMarkdown(
      '<table><thead><tr><th>列1</th><th>列2</th></tr></thead>' +
        '<tbody><tr><td>a</td><td>b</td></tr></tbody></table>',
    );
    expect(text).toContain('| 列1');
    expect(text).toContain('| --- |');
    expect(text).toContain('| a');
  });

  it('keeps strikethrough and fenced code with its language', () => {
    const { text } = convertHtmlToMarkdown(
      '<p><del>删掉</del></p><pre><code class="language-ts">const x = 1;</code></pre>',
    );
    expect(text).toContain('~~删掉~~');
    expect(text).toContain('```ts');
    expect(text).toContain('const x = 1;');
  });

  it('drops script, style and hidden content', () => {
    const { text } = convertHtmlToMarkdown(
      '<head><style>body{color:red}</style><script>alert(1)</script></head>' +
        '<body><p>可见</p><div style="display:none">隐藏</div>' +
        '<div hidden>也隐藏</div><div aria-hidden="true">还隐藏</div>' +
        '<input type="hidden" value="秘密"></body>',
    );
    expect(text).toContain('可见');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('隐藏');
    expect(text).not.toContain('秘密');
  });

  it('cuts the source at maxChars and reports it', () => {
    const html = `<p>${'字'.repeat(500)}</p>`;
    const { text, truncated } = convertHtmlToMarkdown(html, { maxChars: 50 });
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThan(html.length);
  });

  it('reports no truncation for a body under the cap', () => {
    expect(convertHtmlToMarkdown('<p>短</p>').truncated).toBe(false);
  });
});

describe('conversion depth guard', () => {
  it('allows nesting at the ceiling and refuses one level past it', () => {
    const atCeiling = '<div>'.repeat(MAX_CONVERSION_DEPTH) + 'x';
    const pastCeiling = '<div>'.repeat(MAX_CONVERSION_DEPTH + 1) + 'x';
    expect(exceedsConversionDepth(atCeiling)).toBe(false);
    expect(exceedsConversionDepth(pastCeiling)).toBe(true);
  });

  it('refuses a body it would otherwise convert synchronously', () => {
    // Conversion runs on the event loop and cannot be interrupted, so the guard
    // — not the fetch timeout — is what bounds the work.
    expect(() =>
      convertHtmlToMarkdown('<div>'.repeat(MAX_CONVERSION_DEPTH + 50) + 'x'),
    ).toThrow(WebFetchError);
    expect(() =>
      convertHtmlToMarkdown('<div>'.repeat(MAX_CONVERSION_DEPTH + 50) + 'x'),
    ).toThrow(/nests deeper than/);
  });

  it('counts unclosed tags, which is the realistic attack shape', () => {
    expect(exceedsConversionDepth('<div><span>'.repeat(3_000))).toBe(true);
  });

  it('does not count void elements or self-closing tags', () => {
    const voidHeavy = '<br><img src="x"><hr>'.repeat(1_000);
    const selfClosing = '<div/>'.repeat(1_000);
    expect(exceedsConversionDepth(voidHeavy)).toBe(false);
    expect(exceedsConversionDepth(selfClosing)).toBe(false);
  });

  it('does not count text inside raw-text elements as markup', () => {
    const scripts = `<script>${'<div>'.repeat(1_000)}</script><p>ok</p>`;
    expect(exceedsConversionDepth(scripts)).toBe(false);
  });

  it('ignores tags inside comments', () => {
    const commented = `<!-- ${'<div>'.repeat(1_000)} --><p>ok</p>`;
    expect(exceedsConversionDepth(commented)).toBe(false);
  });

  it('respects a quoted > inside an attribute', () => {
    const attribute = `<div title="a > b"><div title="c > d">x</div></div>`;
    expect(exceedsConversionDepth(attribute)).toBe(false);
  });

  it('honours a caller-provided ceiling', () => {
    expect(exceedsConversionDepth('<div>'.repeat(10), 5)).toBe(true);
    expect(exceedsConversionDepth('<div>'.repeat(10), 20)).toBe(false);
  });
});
