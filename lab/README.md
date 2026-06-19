# lab/

Throwaway-until-proven spikes that must NOT touch BlitzOS core. Each subfolder is a self-contained
experiment with its own build + README. Nothing here is wired into `src/main` or the renderer until
a spike graduates into a real plan under `../plans/` and gets approval.

## Current spikes

- **`native-mirror/`** — proving "use any native macOS app inside BlitzOS." Capture every window of a
  target app (ScreenCaptureKit, zero-copy IOSurface), display each as a live mirror we own, and
  forward mouse/keyboard/scroll back to the real app (CGEventPostToPid). Standalone first; the
  BlitzOS integration (IOSurface into the L0 `pages` window + a `nativeapp` surface kind) comes after
  the mechanics hold up.
