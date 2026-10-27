import { Fragment, useEffect, useMemo, useState } from 'react';
import { filterPalette, type PaletteItem } from '../../commands/palette';
import { Icon } from '../../ui/Icon';

interface Props {
  items: PaletteItem[];
  onClose(): void;
}

/**
 * `⌘K`. Session jumping, workspace switching and one-off actions all live here
 * rather than on their own shortcuts — a command palette is the established
 * convention, and a second convention would just have to be learned.
 */
/**
 * How many recent sessions the empty list shows before「加载更多」. Deliberately
 * small: 20 session rows filled the whole list and pushed 工作区/动作 below the
 * fold — the sections the cap was supposed to keep visible. Typing still
 * searches every session.
 */
const SESSION_PAGE = 6;
/** How many more an explicit「加载更多」adds (the user asked for them). */
const SESSION_STEP = 20;

export function CommandPalette({ items, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [sessionLimit, setSessionLimit] = useState(SESSION_PAGE);

  // Only sessions are capped: with a long session list the 动作/工作区 sections
  // were pushed off the end, so「快捷键帮助」and friends looked missing.
  const filtered = useMemo(
    () => filterPalette(items, query, { sectionLimit: { section: '会话', limit: sessionLimit } }),
    [items, query, sessionLimit],
  );

  // Empty query + more sessions than fit → a「加载更多」row closing that section.
  // Searching bypasses it (those results are ranked, not paged).
  const rows = useMemo(() => {
    if (query.trim()) return filtered;
    const total = items.filter((entry) => entry.section === '会话').length;
    const shown = filtered.filter((entry) => entry.section === '会话').length;
    if (total <= shown) return filtered;
    const last = filtered.map((entry) => entry.section).lastIndexOf('会话');
    if (last < 0) return filtered;
    const more: PaletteItem = {
      id: 'more-sessions',
      section: '会话',
      label: `加载更多会话（还有 ${total - shown} 个）`,
      keepOpen: true,
      run: () => setSessionLimit((count) => count + SESSION_STEP),
    };
    return [...filtered.slice(0, last + 1), more, ...filtered.slice(last + 1)];
  }, [filtered, items, query]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  function run(item: PaletteItem | undefined): void {
    if (!item) return;
    // Close first: an action may open another overlay or navigate. Rows that
    // only extend the list ("加载更多") opt out with `keepOpen`.
    if (!item.keepOpen) onClose();
    item.run();
  }

  return (
    <div className="modal-scrim pal-scrim" onClick={onClose}>
      <div className="palette" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="palette-search">
          <Icon name="search" size={16} className="palette-search-icon" />
          <input
            className="palette-input"
            autoFocus
            placeholder="搜索会话、工作区，或执行动作…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setCursor((value) => Math.min(value + 1, Math.max(rows.length - 1, 0)));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setCursor((value) => Math.max(value - 1, 0));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                run(rows[cursor]);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                onClose();
              }
            }}
          />
        </div>

        <div className="palette-list">
          {rows.length === 0 ? (
            <div className="empty">没有匹配项</div>
          ) : (
            rows.map((item, index) => (
              <Fragment key={item.id}>
                {/* A header whenever the section changes keeps the on-screen
                    order identical to the arrow-key order. */}
                {rows[index - 1]?.section !== item.section && (
                  <div className="palette-section">{item.section}</div>
                )}
                <button
                  className={`palette-item${index === cursor ? ' active' : ''}`}
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => run(item)}
                >
                  <span className="palette-label">{item.label}</span>
                  {item.hint && <span className="palette-hint">{item.hint}</span>}
                </button>
              </Fragment>
            ))
          )}
        </div>

        <div className="palette-foot">
          <span>↑↓ 选择 · Enter 执行 · Esc 关闭</span>
        </div>
      </div>
    </div>
  );
}
