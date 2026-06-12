# MaxListenersExceededWarning (11 did-stop-loading listeners) on web guests

**Found:** 2026-06-11 by telemetry on BOTH machines (host dev + VM v0.0.1-11) right after opening
web surfaces.

```
(node:9056) MaxListenersExceededWarning: Possible EventEmitter memory leak detected.
11 did-stop-loading listeners added to [WebContents]. MaxListeners is 10.
```

## Status

- In the **WebContentsView host** (working-tree migration, not yet committed): the per-tab setup
  block attaches 11 listeners by design (focus/context-menu/dom-ready/finish/fail + 6 nav-state
  pushes) — one over Node's warn default. Fixed in the working tree with `wc.setMaxListeners(20)`
  + a comment; rides along when the migration commits.
- On the **committed (#11) code path** the same warning fires, so it has a second source there —
  possibly `persistence.ts`'s per-flush `wc.once('did-stop-loading')` settle-listeners
  accumulating when pages never re-load. NOT yet root-caused on that path; needs a listener-count
  trace before changing anything (don't guess).

## Why it matters

Noise in every session's error stream (telemetry counts it as an err), and if the accumulation is
real (not by-design), it's a slow leak per long-lived web surface.
