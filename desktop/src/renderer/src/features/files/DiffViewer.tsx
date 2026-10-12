import { useLayoutEffect, useMemo, useRef } from 'react';
import { parsePatch, toSplitRows, type DiffRow } from './diff';
import type { DiffResponse } from '../../../../shared/contract';

export type DiffView = 'split' | 'unified';

/**
 * Below this pane width the side-by-side view degrades to unified. Shared by the
 * full files page and the chat's right panel so both switch at the same width.
 */
export const SPLIT_MIN_PX = 640;

interface Props {
  diff: DiffResponse;
  view: DiffView;
}

function gutter(row: DiffRow | null): string {
  if (!row) return '';
  return String(row.newNo ?? row.oldNo ?? '');
}

/** A split cell's non-text width: the gutter, its right margin, and the row padding. */
const SPLIT_CELL_CHROME = 34 + 10 + 20;

/**
 * Rendered from the daemon's raw patch rather than a diff library: the rows are
 * already paired by `toSplitRows`, and both views have to agree on what a row
 * is (docs/local/pages/files.md §6.8 — 并排 is the desktop default, 统一 the
 * fallback when the pane is too narrow).
 */
export function DiffViewer({ diff, view }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => parsePatch(diff.patch), [diff.patch]);
  const pairs = useMemo(() => (view === 'split' ? toSplitRows(rows) : null), [view, rows]);

  // 并排: both columns must be the SAME width so the two sides line up and pan
  // together. CSS cannot take the max across two columns, so measure the widest
  // line with the same font and hand the width to the grid as `--split-colw`.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !pairs) return;
    const style = window.getComputedStyle(element);
    const context = document.createElement('canvas').getContext('2d');
    if (!context) return;
    context.font = `${style.fontSize} ${style.fontFamily}`;
    let widest = 0;
    for (const pair of pairs) {
      for (const side of [pair.left, pair.right]) {
        if (side) widest = Math.max(widest, context.measureText(side.text).width);
      }
    }
    element.style.setProperty('--split-colw', `${Math.ceil(widest) + SPLIT_CELL_CHROME}px`);
  }, [pairs]);

  if (diff.binary) {
    return <div className="fnotice">二进制文件，不显示差异。{diff.truncated && ' （内容过大）'}</div>;
  }

  if (diff.status === 'added' && rows.every((row) => row.kind === 'add')) {
    // A brand-new file: the patch is the whole file, so no diff furniture.
    return (
      <pre className="fcode">
        {rows.map((row) => row.text).join('\n')}
      </pre>
    );
  }

  return (
    <div ref={ref} className={`fdiff${view === 'split' ? ' split' : ''}`}>
      {view === 'split'
        ? pairs!.map((row, index) =>
            row.full ? (
              <div key={index} className={`fdiff-ln full ${row.full.kind}`}>
                {row.full.text}
              </div>
            ) : (
              <div key={index} className="fdiff-pair">
                <div className={`fdiff-ln ${row.left ? row.left.kind : 'empty'}`}>
                  <span className="fdiff-gutter">{gutter(row.left)}</span>
                  <span className="fdiff-text">{row.left?.text ?? ''}</span>
                </div>
                <div className={`fdiff-ln ${row.right ? row.right.kind : 'empty'}`}>
                  <span className="fdiff-gutter">{gutter(row.right)}</span>
                  <span className="fdiff-text">{row.right?.text ?? ''}</span>
                </div>
              </div>
            ),
          )
        : rows.map((row, index) => (
            <div key={index} className={`fdiff-ln ${row.kind}`}>
              <span className="fdiff-gutter">{row.kind === 'hunk' || row.kind === 'meta' ? '' : gutter(row)}</span>
              <span className="fdiff-text">{row.text || ' '}</span>
            </div>
          ))}
      {diff.truncated && <div className="fnotice">diff 过大，已截断显示。</div>}
    </div>
  );
}
