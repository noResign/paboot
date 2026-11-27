/**
 * Skins are a second axis on top of light/dark: each one is a full built-in
 * look — a palette plus an optional effect layer. The base palette (品牌) lives
 * in `tokens.css` at `:root`; other skins override colour tokens under
 * `[data-skin='<id>']`. This table is the registry the picker reads.
 *
 * Adding a palette-only skin is one line here plus its light/dark token block;
 * an effect is one file under `fx/` wired to a skin's `fx` field. The mount
 * point, persistence, and reduced-motion/hidden handling never change.
 */

/** Effect implementations the skin layer knows how to mount. */
export type FxId = 'none' | 'ripple';

interface SkinEntry {
  readonly id: string;
  readonly label: string;
  readonly fx: FxId;
}

export const SKINS = [
  { id: 'brand', label: '品牌', fx: 'none' },
  { id: 'ripple', label: '涟漪', fx: 'ripple' },
] as const satisfies readonly SkinEntry[];

export type SkinId = (typeof SKINS)[number]['id'];

/** One entry of the registry — the id is narrowed to the literal union. */
export type Skin = (typeof SKINS)[number];

export const DEFAULT_SKIN_ID: SkinId = 'brand';

/** Never throws: an unknown/removed id (stale localStorage) falls back to default. */
export function skinById(id: string): Skin {
  return SKINS.find((skin) => skin.id === id) ?? SKINS[0];
}
