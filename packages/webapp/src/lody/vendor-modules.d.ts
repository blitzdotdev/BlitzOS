/**
 * The typecheck seam for the vendored Lody renderer.
 *
 * `npm run typecheck` must not sweep `vendor/lody`. Their packages are written
 * against a pnpm workspace with ~140 dependencies of their own, their own
 * compiler options, and type-only imports that reach into
 * `apps/electron/src/main/**` — typechecking them here would mean adopting all
 * of that, and would turn every upstream merge into a type-repair job on code
 * we do not own. TypeScript resolves these specifiers through no `node_modules`
 * entry (Vite supplies them as aliases, see `vendor-bridge.ts`), so these
 * ambient declarations are what it sees instead.
 *
 * The cost is real and deliberate: every value crossing this seam is `any`, so
 * `webapp/src/lody/` states its own contracts at the call site rather than
 * borrowing theirs. Phase 2 is the place to decide whether the runtime seam
 * earns hand-written declarations or a second tsconfig project that compiles
 * the vendor tree with their options.
 */

// Shorthand ambient declarations: a module declared with no body makes every
// import from it — default, named, or namespace — resolve to `any`.
declare module "@lody/components";
declare module "@lody/components/*";
declare module "@lody/shared";
declare module "@lody/shared/*";
declare module "@lody/platform";
declare module "@lody/platform/*";
declare module "@lody/cloud-api";
declare module "@lody/loro-streams-rpc";
