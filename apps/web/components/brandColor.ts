// The white label accent for code that needs a hex value (chart shades are computed from it), not
// a CSS variable. PlatformShell sets it on every render, before the page under it draws.

const DEFAULT_ACCENT = '#12b8a6';
let accent = DEFAULT_ACCENT;

export function setBrandAccent(hex: string | null | undefined) {
  if (hex && /^#[0-9a-f]{6}$/i.test(hex)) accent = hex;
}

/**
 * A panel card's colour: the one chosen for it, or the white label accent. New cards used to be
 * saved with the default teal, so that value counts as "not chosen" and follows the white label.
 */
export function cardColor(color: string | null | undefined) {
  return !color || color.toLowerCase() === DEFAULT_ACCENT ? accent : color;
}
