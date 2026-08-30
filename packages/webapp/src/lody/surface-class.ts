/**
 * The class name that marks the Lody surface's boundary.
 *
 * It has four readers and no natural owner among them: `lody-surface-shell.css`
 * hangs the surface's box and its token overrides off it, `SessionSurface.tsx`
 * puts it on the wrapper, the fixture render harness reuses it, and
 * `lody-tailwind-containment.test.ts` treats it as the line bleed is measured
 * across. So it lives alone, in the one module all four can import without
 * dragging the vendored renderer in behind it.
 */
export const LODY_SURFACE_CLASS = "lody-surface";
