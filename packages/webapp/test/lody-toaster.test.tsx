/**
 * THE SURFACE HAS A TOAST HOST, SO A VENDORED `toast.*` REACHES A MEMBER
 * (wave 4, C1).
 *
 * The field report: a real-Chromium audit of the live surface found
 * `document.querySelectorAll('[data-sonner-toaster]')` empty. Sonner renders
 * nothing without a mounted `<Toaster/>`; upstream mounts one in
 * `routes/__root.tsx:216`, which is a route we deliberately do not mount, and
 * our own stack did not put one back. Around ninety `toast.*` call sites in the
 * vendored session components were therefore swallowed — a failed fork, a
 * refused close, a copy that did not happen, all answered by silence.
 *
 * `[data-sonner-toaster]` IS NOT THE MOUNT, and this test says so twice. Sonner
 * draws that `<ol>` only while a toast is live (`if (!filteredToasts.length)
 * return null`); what is always there is the `<section>` live region. So the
 * mount is asserted on the region, and the audit's own query is asserted where
 * it means something — after a toast is fired.
 *
 * WHAT IS REAL HERE. `LodySurfaceProviders` is the stack `SessionSurface`
 * renders, mounted whole rather than rebuilt to look like it — the same rule
 * `lody-theme-application.test.tsx` follows, and the same reason: the only
 * harness that ever mounted the real stack needs a `lody` daemon and skips in
 * CI. The toast is fired through `sonner`'s own module, which is the module
 * every vendored call site imports, so what this drives is their path and not a
 * stand-in for it.
 */
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toast } from "sonner";
import { LodySurfaceProviders, LODY_TOASTER_HOST_CLASS } from "../src/lody/surface-providers";
import { LODY_SURFACE_CLASS } from "../src/lody/surface-class";
import { render, settle } from "./dom";

const here = dirname(fileURLToPath(import.meta.url));
const webappSrc = join(here, "..", "src");

class PrefersLightQuery extends EventTarget {
  media = "(prefers-color-scheme: light)";
  onchange = null;
  matches = false;
  addListener(): void {}
  removeListener(): void {}
}

let cleanup: (() => Promise<void>) | null = null;

beforeAll(() => {
  window.matchMedia = () => new PrefersLightQuery();
});

afterEach(async () => {
  toast.dismiss();
  if (cleanup !== null) {
    await cleanup();
    cleanup = null;
  }
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("style");
  window.localStorage.clear();
});

async function mountProviders() {
  const view = await render(<LodySurfaceProviders><div /></LodySurfaceProviders>);
  cleanup = view.unmount;
  return view;
}

/** Fires a toast the way `session-detail.tsx` fires one — `toast.error(message)`
 * on the module both sides import — and lets Sonner commit it. */
async function fireVendoredToast(message: string): Promise<void> {
  await act(async () => {
    toast.error(message);
  });
  await settle();
}

describe("the vendored surface's toast host", () => {
  it("mounts a toaster, so a vendored toast is on screen instead of nowhere", async () => {
    const view = await mountProviders();
    // Always present: Sonner's live region, which is the mount itself.
    expect(view.container.querySelector("section[aria-live]")).not.toBeNull();

    await fireVendoredToast("No assistant response is available to fork");
    // Now the audit's own query answers, and with the message in it.
    expect(view.container.querySelectorAll("[data-sonner-toaster]")).not.toHaveLength(0);
    const rendered = [...view.container.querySelectorAll("[data-sonner-toast]")].map(
      (node) => node.textContent ?? "",
    );
    expect(rendered.join("\n")).toContain("No assistant response is available to fork");
    // ONE toaster and therefore one toast. Two hosts would show every message
    // twice, which is the failure mode a second mount produces.
    expect(rendered).toHaveLength(1);
  });

  it("puts the toaster below the theme provider, so it paints in the shell's mode", async () => {
    const view = await mountProviders();
    await fireVendoredToast("Unable to close side chat");
    const toaster = view.container.querySelector("[data-sonner-toaster]");
    // Their wrapper (`ui/sonner.tsx`) reads `useResolvedTheme()` and hands
    // Sonner the RESOLVED mode; outside a `ThemeProvider` that hook has nothing
    // to read. `adoptShellTheme()` has already put the shell's choice in, so a
    // resolved attribute here is the whole chain working.
    expect(toaster?.getAttribute("data-sonner-theme")).toBe("dark");
    // And it reads the surface's tokens rather than Sonner's built-in greys,
    // because their wrapper points the three `--normal-*` variables at the
    // popover tokens the generated Blitz sheet declares on `.lody-surface`.
    const style = toaster?.getAttribute("style") ?? "";
    expect(style).toContain("--normal-text: hsl(var(--popover-foreground))");
  });

  it("keeps the host out of the surface's flex column", async () => {
    const view = await mountProviders();
    const host = view.container.querySelector(`.${LODY_TOASTER_HOST_CLASS}`);
    expect(host, "the toaster has our own wrapper to hang a rule on").not.toBeNull();
    expect(host?.querySelector("section[aria-live]")).not.toBeNull();
    // jsdom runs no layout, so what is checkable here is that the rule exists
    // and names this class. WHAT IT PREVENTS needs a browser: `.lody-surface >
    // *` gives every child `flex: 1 1 auto`, and Sonner's live region is an
    // empty `<section>` whose toasts are all `position: fixed` — so without the
    // exception an element with no content takes a share of the surface height.
    const shellCss = readFileSync(join(webappSrc, "lody", "lody-surface-shell.css"), "utf8");
    expect(shellCss).toContain(`.${LODY_TOASTER_HOST_CLASS} {\n  flex: 0 0 auto;\n}`);
    expect(shellCss).toContain(`.${LODY_SURFACE_CLASS} > * {`);
  });

  it("is the same element upstream's root route mounts", async () => {
    // The seam this keeps trivial: we mount THEIR `Toaster` with THEIR props, so
    // an upstream change to the toast chrome arrives with the merge and there is
    // nothing of ours to reconcile. A rename upstream fails here rather than in
    // a browser.
    const root = readFileSync(
      join(here, "..", "..", "..", "vendor", "lody", "packages", "components", "src", "routes", "__root.tsx"),
      "utf8",
    );
    expect(root).toContain("import { Toaster } from '@/ui/sonner';");
    expect(root).toContain("<Toaster />");
    const ours = readFileSync(join(webappSrc, "lody", "surface-providers.tsx"), "utf8");
    expect(ours).toContain('import { Toaster } from "@lody/components/ui/sonner";');
    expect(ours).toContain("<Toaster />");
  });
});
