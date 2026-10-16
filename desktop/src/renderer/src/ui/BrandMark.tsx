import { MASCOT_HEAD_PATH } from './brand-glyph';

/**
 * 应用品牌标：品牌渐变方块 + 白色吉祥物头像。
 *
 * 与 Android 侧一致——`ConnectScreen` 用的是 `Brand.Gradient` 底 + `BrandGlyph`
 * 白图标，盒子 72dp、字形 50dp（占 70%）、圆角 22dp（占 30%）。`.brand-mark` 类给出同样的
 * 方块与圆角（30px / 9px = 30%），字形按同样的 70% 取整。
 *
 * 70% 而不是更小：字形是**填充**而非描边（路径本身就是墨迹轮廓，`fillRule="evenodd"`
 * 让脸部的眼/鼻/嘴自动成为负空间），比机器人那种细描边吃尺寸，60% 以下整张脸就糊了。
 * 这个比例也正好是 app 图标里那只狗的占比。
 */
export function BrandMark({ size = 30 }: { size?: number }) {
  const glyph = Math.round(size * 0.7);
  return (
    <span className="brand-mark" style={{ width: size, height: size }} aria-hidden="true">
      <svg width={glyph} height={glyph} viewBox="0 0 20 20" aria-hidden="true">
        <path d={MASCOT_HEAD_PATH} fill="#fff" fillRule="evenodd" />
      </svg>
    </span>
  );
}
