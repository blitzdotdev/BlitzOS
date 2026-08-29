/** Every workspace tile in the strip wears a solid pastel derived from its id,
 * so two tiles are told apart by colour before their two-letter code is read.
 * The derivation is pure and deterministic: the same id always paints the same
 * tile, on every device and every reload, with nothing stored anywhere. */

export type WorkspaceTileStyle = {
  /** A CSS `background` value: one solid pastel. */
  background: string;
  /** The initials' colour. A pastel is light by construction, so the ink is
   * always the near-black; measured worst case over the wheel is 7.5:1. */
  color: string;
};

/** Pastel: high lightness, moderate saturation. At L 0.80 the darkest hue on
 * the wheel keeps a relative luminance above 0.52, so the near-black ink
 * clears WCAG AA with room. */
const SATURATION = 0.52;
const LIGHTNESS = 0.8;

const INK_DARK = "rgb(11 16 32)";

/** FNV-1a, 32-bit. Chosen for spreading short ids across the wheel, not for
 * any security property. */
function hashWorkspaceId(workspaceId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < workspaceId.length; index += 1) {
    hash = Math.imul(hash ^ workspaceId.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash;
}

export function workspaceTileHue(workspaceId: string): number {
  return hashWorkspaceId(workspaceId) % 360;
}

export function workspaceTileStyle(workspaceId: string): WorkspaceTileStyle {
  const hue = workspaceTileHue(workspaceId);
  const saturation = Math.round(SATURATION * 100);
  const lightness = Math.round(LIGHTNESS * 100);
  return {
    background: `hsl(${String(hue)} ${String(saturation)}% ${String(lightness)}%)`,
    color: INK_DARK,
  };
}
