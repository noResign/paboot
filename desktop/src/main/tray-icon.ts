/**
 * The tray icon, inlined as base64 rather than shipped as a binary asset: it is
 * ~1.5 KB (~4 KB for the 2x), and an asset would need to survive electron-vite's
 * bundling plus electron-builder's `files` rules on three platforms for no
 * benefit.
 *
 * The artwork is the mascot's head on the brand gradient tile — the same tile
 * and the same line art as `build/icon.png`, cropped to the head. The whole
 * mascot is a lying dog holding a tablet at roughly 1.8:1; shrunk into a
 * menu-bar-sized square it turns to a smudge, so the tray keeps only the head
 * it can actually resolve (ear, closed eye, snout). Measured against the app
 * icon downscaled to the same sizes.
 *
 * Source: `android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png`
 * (the white line art on transparency) composited onto the tile gradient
 * #0E9F86 -> #18C9A6 with the app icon's own 19.5% corner radius.
 *
 * `TRAY_ICON_1X` is 22px — the macOS menu bar height, and about what every
 * other tray host asks for — and `TRAY_ICON_2X` its 44px Retina counterpart,
 * registered as a scale factor 2 representation in `tray.ts`.
 */
export const TRAY_ICON_1X_PNG_BASE64 =
  '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'
  'AABJRU5ErkJggg==';

export const TRAY_ICON_2X_PNG_BASE64 =
  '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';
