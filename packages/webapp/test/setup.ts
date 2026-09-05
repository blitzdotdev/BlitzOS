// Node-environment files (`// @vitest-environment node`) share this setup, and
// they have no DOM to stub. Guard so the transport spike can run outside jsdom.
if (typeof HTMLCanvasElement !== "undefined") {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => null,
  });

  // Node 26 exposes a native localStorage getter that returns undefined unless
  // the process was started with --localstorage-file. That getter takes
  // precedence over jsdom's Storage object. Use jsdom's branded session
  // storage as the isolated test backing so StorageEvent validation also
  // recognizes it as a real Storage instance.
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: globalThis.sessionStorage,
  });
}
