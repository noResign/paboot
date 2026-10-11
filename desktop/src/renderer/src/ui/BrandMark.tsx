import { ROBOT_GLYPH } from './RuntimeIcon';

/**
 * 应用品牌标：品牌渐变方块 + 白色机器人字形。
 *
 * 与 Android 侧一致——`ConnectScreen` 用的是 `Brand.Gradient` 底 + `Icons.Rounded.SmartToy`
 * 白图标，盒子 72dp、字形 38dp（占 53%）、圆角 22dp（占 30%）。`.brand-mark` 类给出同样的
 * 方块与圆角（30px / 9px = 30%），字形按同样的 53% 取整。
 *
 * `strokeWidth` 比 `RuntimeIcon` 的默认值粗一档：品牌标里字形只有 16px，1.5 太细会糊。
 */
export function BrandMark({ size = 30 }: { size?: number }) {
  const glyph = Math.round(size * 0.53);
  return (
    <span className="brand-mark" style={{ width: size, height: size }} aria-hidden="true">
      <svg
        width={glyph}
        height={glyph}
        viewBox="0 0 20 20"
        fill="none"
        stroke="#fff"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={ROBOT_GLYPH} />
      </svg>
    </span>
  );
}
