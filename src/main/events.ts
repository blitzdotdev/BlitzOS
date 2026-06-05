// The perception kernel (moment coalescer + content-share consent + in-page sensors)
// now lives in the shared, transport-agnostic perception-core.mjs, so the Electron
// main and the server-mode backend (preview/backend.mjs) run the SAME implementation
// with no drift. This module re-exports it for the existing Electron imports.
export * from './perception-core.mjs'
export type { BlitzMoment } from './perception-core.mjs'
