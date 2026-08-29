/** Every workspace tile in the strip wears a gradient derived from its id, so
 * two tiles are told apart by colour before their two-letter code is read. The
 * derivation is pure and deterministic: the same id always paints the same
 * tile, on every device and every reload, with nothing stored anywhere. */

type Rgb = { red: number; green: number; blue: number };

export type WorkspaceTileStyle = {
  /** A CSS `background` value: the two-stop gradient. */
  background: string;
  /** The initials' colour, picked so the tile clears WCAG AA (4.5:1). */
  color: string;
};

/** The second stop is a short walk around the wheel: far enough to read as a
 * gradient, near enough that the tile stays one colour rather than two. */
const HUE_SPREAD = 40;
const SATURATION = 0.58;
const LIGHTNESS = 0.46;

/** Against a background of this luminance neither white nor black reaches
 * 4.5:1 with any margin — 4.58:1 is the best a pure black or white can do, and
 * these near-black and near-white inks do worse. Tiles that land in the band
 * are darkened out of it, which keeps the near-white ink well past AA. */
const AMBIGUOUS_LUMINANCE_MIN = 0.16;
const AMBIGUOUS_LUMINANCE_MAX = 0.26;
const DARKEN_FACTOR = 0.66;

const INK_LIGHT: Rgb = { red: 248, green: 250, blue: 252 };
const INK_DARK: Rgb = { red: 11, green: 16, blue: 32 };

/** FNV-1a, 32-bit. Chosen for spreading short ids across the wheel, not for
 * any security property. */
function hashWorkspaceId(workspaceId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < workspaceId.length; index += 1) {
    hash = Math.imul(hash ^ workspaceId.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash;
}

function hueToRgb(hue: number): Rgb {
  const chroma = (1 - Math.abs(2 * LIGHTNESS - 1)) * SATURATION;
  const sector = hue / 60;
  const second = chroma * (1 - Math.abs((sector % 2) - 1));
  const base = LIGHTNESS - chroma / 2;
  const channels: [number, number, number] = sector < 1 ? [chroma, second, 0]
    : sector < 2 ? [second, chroma, 0]
    : sector < 3 ? [0, chroma, second]
    : sector < 4 ? [0, second, chroma]
    : sector < 5 ? [second, 0, chroma]
    : [chroma, 0, second];
  return {
    red: Math.round((channels[0] + base) * 255),
    green: Math.round((channels[1] + base) * 255),
    blue: Math.round((channels[2] + base) * 255),
  };
}

function darken(color: Rgb): Rgb {
  return {
    red: Math.round(color.red * DARKEN_FACTOR),
    green: Math.round(color.green * DARKEN_FACTOR),
    blue: Math.round(color.blue * DARKEN_FACTOR),
  };
}

function channelLuminance(value: number): number {
  const unit = value / 255;
  return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
function relativeLuminance(color: Rgb): number {
  return 0.2126 * channelLuminance(color.red)
    + 0.7152 * channelLuminance(color.green)
    + 0.0722 * channelLuminance(color.blue);
}

/** WCAG contrast ratio between two relative luminances. */
function contrastRatio(one: number, other: number): number {
  const lighter = Math.max(one, other);
  const darker = Math.min(one, other);
  return (lighter + 0.05) / (darker + 0.05);
}

function css(color: Rgb): string {
  return `rgb(${String(color.red)} ${String(color.green)} ${String(color.blue)})`;
}

/** The two gradient stops. The ink has to read over both, so the pair's
 * average luminance is what the ink choice is made against. */
function workspaceTileStops(workspaceId: string): [Rgb, Rgb] {
  const hue = hashWorkspaceId(workspaceId) % 360;
  const start = hueToRgb(hue);
  const end = hueToRgb((hue + HUE_SPREAD) % 360);
  const luminance = (relativeLuminance(start) + relativeLuminance(end)) / 2;
  if (luminance < AMBIGUOUS_LUMINANCE_MIN || luminance > AMBIGUOUS_LUMINANCE_MAX) {
    return [start, end];
  }
  return [darken(start), darken(end)];
}

/** The inline style for one workspace tile. */
export function workspaceTileStyle(workspaceId: string): WorkspaceTileStyle {
  const [start, end] = workspaceTileStops(workspaceId);
  const luminance = (relativeLuminance(start) + relativeLuminance(end)) / 2;
  const light = contrastRatio(relativeLuminance(INK_LIGHT), luminance);
  const dark = contrastRatio(relativeLuminance(INK_DARK), luminance);
  return {
    background: `linear-gradient(135deg, ${css(start)} 0%, ${css(end)} 100%)`,
    color: css(light >= dark ? INK_LIGHT : INK_DARK),
  };
}
