// Hand-written declarations for island-bridge.mjs (typecheck enforces a .d.mts sibling for every .mjs that
// a .ts file imports — same mechanism as relay.mjs/relay.d.mts and os-tools.mjs/os-tools.d.mts). Dependency-
// light, no electron types. ws ships its own types (ws@8), so no @types/ws needed for this to resolve.

import type { Server } from 'node:http'
import type { WebSocket, WebSocketServer } from 'ws'

/** The runtime dependencies the island bridge dispatches to (injected by index.ts, which has electron, via
 *  setIslandDeps before the control server starts). Pure-node defaults are no-ops so a connect before wiring
 *  degrades to an empty list, never throws. The bridge stays vocabulary-free — it String()-coerces whatever
 *  these emit; index.ts owns the host→island status mapping + the chat.md tail. */
export interface IslandDeps {
  /** chat-bar Send. Returns the new tab's {id, title} (synchronously); status/auto-name converge later. */
  spawn(args: { prompt: string; paths: string[]; orchestrators: boolean }): { id: string; title: string }
  /** Continue an existing tab. */
  message(args: { id: string; text: string; paths: string[] }): void
  /** Flip the orchestrators toggle on an existing tab (live, no restart). */
  setOrchestrators(id: string, on: boolean): void
  /** The current process list (FULL snapshot, sent on connect). */
  listProcesses(): Array<{ id: string; title: string; state: string }>
  /** Subscribe to live events. The cb carries reply LINES ({id, line:{at,text}}), status/auto-name UPSERTS
   *  ({id, upsert:{title?, state?}}), or an optional full re-snapshot ({list}). Returns an unsubscribe. */
  subscribeEvents(
    cb: (ev: {
      id?: string
      line?: { at: number; text: string }
      upsert?: { title?: string; state?: string }
      list?: Array<{ id: string; title: string; state: string }>
    }) => void
  ): () => void
}

/** Replace the injected dependencies (index.ts calls this once, before startControlServer). Shallow-merged
 *  so a partial inject keeps the no-op defaults for the rest. */
export function setIslandDeps(next: Partial<IslandDeps>): void

/** Mount the token-gated island WS endpoint on an existing HTTP server: path /island, ?token= must === token
 *  (empty token = test-only "no auth"). Returns the WebSocketServer (handy for tests/teardown). */
export function attachIslandWebSocket(server: Server, token: string): WebSocketServer

/** Per-connection handler: sends the {t:'process.list'} snapshot (deps.listProcesses) + {t:'ping'} on
 *  connect; subscribes (per-connection, unsubscribed on close AND error) to forward {t:'process.event'} /
 *  {t:'process.upsert'} / {t:'process.list'}; dispatches inbound {t:'process.spawn'|'process.message'|
 *  'process.orchestrators'} to the matching dep (each try/catch-guarded); handles {t:'hello'} (log) /
 *  {t:'pong'} (mark alive) / other (log), with no leaks. */
export function onIslandConnection(ws: WebSocket): void

export interface IslandHelperHandle {
  /** Stop OUR relaunch supervision (non-destructive: the running island is left alive). */
  stop(): void
}

/** Launch + supervise BlitzIsland.app at a resolved path (caller resolves the path; this stays electron-
 *  free). macOS-only — returns a no-op handle on other platforms so the wiring is unconditional. Dup-guarded
 *  (pgrep -x BlitzIsland) so a singleton notch HUD is never duplicated. opts.{pgrep,open} are injectable
 *  command runners for a future launch test; opts.debounceMs tunes the relaunch debounce (default 800ms). */
export function launchIslandHelper(
  appPath: string,
  opts?: {
    debounceMs?: number
    pgrep?: (cb: (running: boolean) => void) => void
    open?: (appPath: string) => void
  }
): IslandHelperHandle
