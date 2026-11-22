import type { ReactNode } from 'react';

export interface TabItem {
  id: string;
  label: ReactNode;
  content: ReactNode;
  disabled?: boolean;
}

interface CommonProps {
  tabs: readonly TabItem[];
  activeId: string;
  /** Stable DOM id prefix shared by the bar and its panel host. */
  idPrefix: string;
}

function tabId(prefix: string, id: string): string {
  return `${prefix}-tab-${id}`;
}

function panelId(prefix: string, id: string): string {
  return `${prefix}-panel-${id}`;
}

/**
 * The tab strip. Kept separate from {@link TabPanels} so a page can place its
 * own chrome (banners, filters, a composer shell) between the two.
 */
export function TabBar({
  tabs,
  activeId,
  onChange,
  label,
  idPrefix,
}: CommonProps & {
  onChange(id: string): void;
  /** Accessible name for the tab list. */
  label: string;
}) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={tabId(idPrefix, tab.id)}
          aria-controls={panelId(idPrefix, tab.id)}
          aria-selected={tab.id === activeId}
          className={`tab${tab.id === activeId ? ' active' : ''}`}
          disabled={tab.disabled}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Keep-alive tab panels.
 *
 * Every panel stays mounted; only the inactive ones are hidden. Switching tabs
 * therefore keeps component state and scroll offsets, and adding a page is one
 * more entry in `tabs` instead of another conditional render branch.
 *
 * Hidden panels use `visibility: hidden` + `pointer-events: none` rather than
 * `display: none`: the panel keeps its layout box, so `scrollTop` survives.
 * `inert` keeps its controls out of the focus order while hidden.
 */
export function TabPanels({ tabs, activeId, idPrefix }: CommonProps) {
  return (
    <div className="tab-panels">
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <section
            key={tab.id}
            id={panelId(idPrefix, tab.id)}
            role="tabpanel"
            aria-labelledby={tabId(idPrefix, tab.id)}
            aria-hidden={!active}
            className={`tab-panel${active ? ' active' : ''}`}
            inert={!active}
          >
            {tab.content}
          </section>
        );
      })}
    </div>
  );
}
