import type { ReactElement } from 'react';
import { comboLabel } from '../../shortcuts/shortcuts';
import { IS_MAC } from '../../ui/platform';
import { Icon, type IconName } from '../../ui/Icon';

export type ShellPage = 'chat' | 'settings' | 'tasks';

interface Props {
  page: ShellPage;
  onGoChat(): void;
  onGoTasks(): void;
  onGoSettings(): void;
}

/**
 * The far-left app rail: global destinations, not workspace content. It stays
 * visible when the session rail is collapsed, so these entries never disappear
 * with ⌘B.
 */
interface Item {
  id: ShellPage;
  label: string;
  icon: IconName;
  combo: string;
  run(): void;
}

export function ActivityBar({ page, onGoChat, onGoTasks, onGoSettings }: Props) {
  const top: Item[] = [
    { id: 'chat', label: '会话', icon: 'message', combo: 'go-sessions', run: onGoChat },
    { id: 'tasks', label: '定时任务', icon: 'clock', combo: 'go-tasks', run: onGoTasks },
  ];
  // Settings is an occasional destination: pinned to the bottom-left corner.
  const bottom: Item = {
    id: 'settings',
    label: '设置',
    icon: 'settings',
    combo: 'go-settings',
    run: onGoSettings,
  };

  const render = (item: Item): ReactElement => {
    const active = page === item.id;
    return (
      <button
        key={item.id}
        className={`activity-btn${item === bottom ? ' activity-btn-bottom' : ''}${active ? ' active' : ''}`}
        title={`${item.label} ${comboLabel(item.combo, IS_MAC)}`}
        aria-label={item.label}
        aria-current={active ? 'page' : undefined}
        onClick={item.run}
      >
        <Icon name={item.icon} size={18} />
      </button>
    );
  };

  return (
    <nav className="activity-bar" aria-label="主导航">
      {top.map(render)}
      {render(bottom)}
    </nav>
  );
}
