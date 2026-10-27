import { create } from 'zustand';
import { DEFAULT_SKIN_ID, SKINS, skinById, type SkinId } from '../ui/skins';

/**
 * Appearance preferences. These live in `localStorage`, which is legitimate here
 * precisely because the renderer is served from the `paboot://` scheme (a real
 * `standard + secure` origin) rather than `file://` — and because they are not
 * secrets, unlike the daemon token, which never comes near the renderer.
 */
export type ThemePreference = 'light' | 'dark' | 'system';

/**
 * How a diff is rendered. Persisted (unlike the panel's open file, which is
 * session state): closing the file panel and opening it again must not silently
 * put the reader back on 统一.
 */
export type DiffViewPreference = 'unified' | 'split';

export const ZOOM_MIN = 90;
export const ZOOM_MAX = 150;
export const RAIL_MIN = 240;
export const RAIL_MAX = 400;
export const ASIDE_MIN = 320;
/** Wide enough for a directory column plus two readable diff columns. */
export const ASIDE_MAX = 880;

interface AppearanceState {
  theme: ThemePreference;
  /** Effect-layer skin — a second axis on top of light/dark (see `ui/skins`). */
  skin: SkinId;
  zoom: number;
  /** Diff rendering mode for the file panel — a display preference, not file state. */
  diffView: DiffViewPreference;
  railWidth: number;
  /** The session rail. Collapsed leaves a thin strip so it can always be reopened. */
  railVisible: boolean;
  /** The conversation column itself — collapsing hands its width to the right panel. */
  chatVisible: boolean;
  /** The chat's right panel (changed files / files), §6.8. Defaults to collapsed. */
  asideVisible: boolean;
  asideWidth: number;
  setTheme(theme: ThemePreference): void;
  setSkin(skin: SkinId): void;
  setZoom(zoom: number): void;
  setDiffView(view: DiffViewPreference): void;
  setRailWidth(width: number): void;
  toggleRail(): void;
  toggleChat(): void;
  toggleAside(): void;
  setAsideWidth(width: number): void;
}

const STORAGE_KEY = 'paboot.appearance';

interface Stored {
  theme: ThemePreference;
  skin: SkinId;
  zoom: number;
  /** Diff rendering mode for the file panel — a display preference, not file state. */
  diffView: DiffViewPreference;
  railWidth: number;
  railVisible: boolean;
  chatVisible: boolean;
  asideVisible: boolean;
  asideWidth: number;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): 'light' | 'dark' {
  if (preference === 'system') return prefersDark ? 'dark' : 'light';
  return preference;
}

function load(): Stored {
  const fallback: Stored = {
    theme: 'system',
    skin: DEFAULT_SKIN_ID,
    zoom: 100,
    diffView: 'unified',
    railWidth: 300,
    railVisible: true,
    chatVisible: true,
    asideVisible: false,
    asideWidth: 420,
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Stored>;
    return {
      theme: parsed.theme === 'light' || parsed.theme === 'dark' ? parsed.theme : 'system',
      // An id that no longer exists (renamed/removed skin) falls back, rather
      // than leaving `data-skin` pointing at nothing.
      skin: SKINS.some((skin) => skin.id === parsed.skin) ? (parsed.skin as SkinId) : DEFAULT_SKIN_ID,
      zoom: clamp(Number(parsed.zoom) || 100, ZOOM_MIN, ZOOM_MAX),
      // Written before this field existed → unified, the documented default.
      diffView: parsed.diffView === 'split' ? 'split' : 'unified',
      railWidth: clamp(Number(parsed.railWidth) || 300, RAIL_MIN, RAIL_MAX),
      // These default to open: an absent field means "written before this existed".
      railVisible: parsed.railVisible !== false,
      chatVisible: parsed.chatVisible !== false,
      // ...except the right panel, which the user asked to start collapsed.
      asideVisible: parsed.asideVisible === true,
      asideWidth: clamp(Number(parsed.asideWidth) || 420, ASIDE_MIN, ASIDE_MAX),
    };
  } catch {
    return fallback;
  }
}

export const useAppearance = create<AppearanceState>((set, get) => ({
  ...load(),

  setTheme(theme) {
    set({ theme });
    persist(get());
    applyAppearance(get());
  },
  setSkin(skin) {
    set({ skin });
    persist(get());
    applyAppearance(get());
  },
  setZoom(zoom) {
    set({ zoom: clamp(zoom, ZOOM_MIN, ZOOM_MAX) });
    persist(get());
    applyAppearance(get());
  },
  setDiffView(diffView) {
    set({ diffView });
    persist(get());
  },
  setRailWidth(railWidth) {
    set({ railWidth: clamp(railWidth, RAIL_MIN, RAIL_MAX) });
    persist(get());
  },
  toggleRail() {
    set({ railVisible: !get().railVisible });
    persist(get());
  },
  toggleChat() {
    set({ chatVisible: !get().chatVisible });
    persist(get());
  },
  toggleAside() {
    set({ asideVisible: !get().asideVisible });
    persist(get());
  },
  setAsideWidth(asideWidth) {
    set({ asideWidth: clamp(asideWidth, ASIDE_MIN, ASIDE_MAX) });
    persist(get());
  },
}));

function persist(state: Stored): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        theme: state.theme,
        skin: state.skin,
        zoom: state.zoom,
        diffView: state.diffView,
        railWidth: state.railWidth,
        railVisible: state.railVisible,
        chatVisible: state.chatVisible,
        asideVisible: state.asideVisible,
        asideWidth: state.asideWidth,
      }),
    );
  } catch {
    /* storage disabled — appearance just won't survive a restart */
  }
}

/** Push the preference onto the document. Called on boot and on every change. */
export function applyAppearance(state: Stored): void {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  document.documentElement.dataset['theme'] = resolveTheme(state.theme, media.matches);
  // The skin is an effect layer, not a colour scheme — `ui/SkinFx` reads the same
  // value back through the store. Kept on the DOM too so CSS can target it.
  document.documentElement.dataset['skin'] = state.skin;
  // `data-fx` lets CSS know an effect is live: `--page-bg` (tokens.css) goes
  // transparent off it, so the canvas is not covered by page backdrops.
  document.documentElement.dataset['fx'] = skinById(state.skin).fx;
  // Chromium-only `zoom` is fine: Electron means there is exactly one engine.
  document.body.style.zoom = `${state.zoom}%`;
}

export function initAppearance(): () => void {
  applyAppearance(useAppearance.getState());
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = (): void => {
    if (useAppearance.getState().theme === 'system') applyAppearance(useAppearance.getState());
  };
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}
