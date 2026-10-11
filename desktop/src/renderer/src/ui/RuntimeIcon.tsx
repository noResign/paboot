import { runtimeIdentity } from '../../../shared/runtime-identity';

/**
 * 机器人字形。品牌标（[BrandMark](BrandMark.tsx)）与 Claude 运行时身份共用，
 * 对应 Android 侧的 `Icons.Rounded.SmartToy`——那边也是同一个字形用在这两处。
 */
export const ROBOT_GLYPH =
  'M11 2v2M8 4h6a3 3 0 013 3v6a3 3 0 01-3 3H7a3 3 0 01-3-3V7a3 3 0 013-3zM9 9v2M13 9v2M9 13h4';

const PATHS: Record<string, string> = {
  robot: ROBOT_GLYPH,
  // terminal prompt
  terminal: 'M4 5h12v10H4zM7 9l2 2-2 2M11 13h3',
  // generic tool
  build: 'M12 3l2 4 4 .6-3 2.9.7 4.2L12 12.6 8.3 14.7 9 10.5 6 7.6l4-.6z',
};

export function RuntimeIcon({ id, size = 14 }: { id: string; size?: number }) {
  const identity = runtimeIdentity(id);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke={identity.color}
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[identity.icon] ?? PATHS['build']!} />
    </svg>
  );
}

export function RuntimeBadge({ id }: { id: string }) {
  const identity = runtimeIdentity(id);
  return (
    <span className="runtime-badge" style={{ color: identity.color }}>
      <RuntimeIcon id={id} />
      {identity.displayName}
    </span>
  );
}
