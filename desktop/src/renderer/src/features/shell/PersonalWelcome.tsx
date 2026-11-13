import { BrandMark } from '../../ui/BrandMark';
import { Icon } from '../../ui/Icon';

interface Props {
  onEnter(): void;
  onAddProject(): void;
}

/**
 * Standalone first-run welcome. It owns the whole window before the rail/shell
 * exists; entering personal space is the only required action. Adding a project
 * is deliberately a secondary path for users who already know what they want.
 */
export function PersonalWelcome({ onEnter, onAddProject }: Props) {
  return (
    <div className="personal-welcome">
      <div className="personal-welcome-inner">
        <div className="personal-welcome-brand">
          <BrandMark size={72} />
        </div>
        <span className="personal-welcome-kicker">欢迎使用 PABOOT</span>
        <h1>先和个人空间打个招呼</h1>
        <p className="personal-welcome-lede">
          个人空间是你的日常入口：聊天、记录想法、生活问答等。记忆功能会记录你的日常偏好和待办事项。要让
          agent 操作其他目录的文件、代码等，可以添加新项目空间。
        </p>
        <div className="personal-welcome-actions">
          <button className="btn primary personal-welcome-enter" onClick={onEnter}>
            进入个人空间
            <Icon name="chevron-right" size={15} />
          </button>
          <button className="personal-welcome-project" onClick={onAddProject}>
            <Icon name="folder" size={15} />
            添加项目空间
          </button>
        </div>
        <div className="personal-welcome-traits" aria-label="个人空间能力">
          <span>
            <Icon name="eye" size={14} />
            聊天与记录
          </span>
          <span>
            <Icon name="check" size={14} />
            记住偏好与待办
          </span>
          <span>
            <Icon name="folder" size={14} />
            随时添加项目
          </span>
        </div>
      </div>
    </div>
  );
}
