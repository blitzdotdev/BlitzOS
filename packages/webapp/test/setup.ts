// Node-environment files (`// @vitest-environment node`) share this setup, and
// they have no DOM to stub. Guard so the transport spike can run outside jsdom.
if (typeof HTMLCanvasElement !== "undefined") {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => null,
  });
}
