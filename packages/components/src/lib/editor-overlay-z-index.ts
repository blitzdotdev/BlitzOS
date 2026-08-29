export const EDITOR_OVERLAY_Z_INDEX = {
  diffGutter: 10,
  selection: 20,
  cursor: 30,
  cursorLabel: 40,
  hover: 50,
  dialogOverlay: 70,
  dialog: 80,
  commandPalette: 85,
  tooltip: 90,
  toast: 100,
} as const;

export type EditorOverlayLayer = keyof typeof EDITOR_OVERLAY_Z_INDEX;

export const EDITOR_OVERLAY_CSS_VARIABLES = {
  diffGutter: '--z-editor-diff-gutter',
  selection: '--z-editor-selection',
  cursor: '--z-editor-cursor',
  cursorLabel: '--z-editor-cursor-label',
  hover: '--z-editor-hover',
  dialogOverlay: '--z-dialog-overlay',
  dialog: '--z-dialog',
  commandPalette: '--z-command-palette',
  tooltip: '--z-tooltip',
  toast: '--z-toast',
} satisfies Record<EditorOverlayLayer, `--z-${string}`>;

export function getEditorOverlayZIndex(layer: EditorOverlayLayer): number {
  return EDITOR_OVERLAY_Z_INDEX[layer];
}

export function getEditorOverlayCssVariable(layer: EditorOverlayLayer): `var(--z-${string})` {
  return `var(${EDITOR_OVERLAY_CSS_VARIABLES[layer]})`;
}
