/**
 * The lazy half of the preview, mirroring `LodySessionsRegion`.
 *
 * IT IS LAZY ON PURPOSE. In the product every Lody stylesheet —
 * `lody-surface.css` (the vendored Tailwind, inside `@layer lody`),
 * `lody-surface-shell.css` and `blitz-skin.css` — is imported by
 * `SessionSurface.tsx`, which `LodySessionsRegion` reaches through a dynamic
 * import. So in a production build they are emitted as a SEPARATE CSS file and
 * appended to `<head>` when the chunk loads, after the entry stylesheet. A
 * preview that imported them at the entry level would put them in a different
 * place in the cascade than the product does, and could therefore show a rule
 * winning that loses in production. This keeps the boundary where the product
 * has it.
 *
 * The DOM it produces is the product's: the vendored sidebar is portalled into
 * the rail's `.session-list.session-list--vendor` host, and the surface is an
 * absolutely-positioned `.lody-surface` over `.webapp-workspace-view` — the
 * same two mounts, sharing one provider stack, that
 * `plans/LODY-SESSIONS.md` §0.3 describes.
 *
 * WHAT IT DELIBERATELY DOES NOT MIRROR: the capability probe. §17 put a
 * `sessions !== "present"` gate in front of the lazy import, so a box on a
 * pre-Lody image never fetches the chunk and `SessionRail` withholds the
 * vendored host entirely (`box-capability.ts`, `use-lody-rail.ts`). There is no
 * box behind this page, so there is nothing to probe and the gate has no
 * meaning here — the preview mounts as though the capability were `present`,
 * which is the only state that has a surface to look at. The LAZY BOUNDARY is
 * mirrored, because that is the part the cascade depends on.
 */
import { Suspense, lazy, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const SurfacePreviewBody = lazy(async () => await import("./body"));

/**
 * Hands the rail's list host and the surface's host to the lazy body once both
 * exist, exactly as `CloudApp` hands `railHost` to `LodySessionsRegion`.
 */
export function SurfacePreviewRegion(): ReactNode {
  const [railHost, setRailHost] = useState<HTMLElement | null>(null);
  const [viewHost, setViewHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setViewHost(document.querySelector<HTMLElement>(".webapp-workspace-view"));
  }, []);

  return (
    <>
      <div
        className="session-list session-list--vendor"
        role="group"
        aria-label="Sessions"
        ref={setRailHost}
      />
      <Suspense fallback={null}>
        {railHost !== null && viewHost !== null && (
          <SurfacePreviewBody railHost={railHost} viewHost={viewHost} />
        )}
      </Suspense>
    </>
  );
}

/** Re-exported so `body.tsx` can portal without importing React DOM twice. */
export { createPortal };
