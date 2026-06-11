// terminalStream — routes the live terminal byte-stream from the os:action channel to the right
// terminal surface. App.tsx's onAction handler calls pushTerminalData/pushTerminalExit when a
// 'terminal-data'/'terminal-exit' action arrives (server: over SSE; Electron: over IPC); a
// TerminalView subscribes by its terminal id. A tiny per-id buffer bridges the gap between a
// terminal mounting (it fetches scrollback once) and its subscription, so nothing is dropped.
type DataCb = (data: string) => void
type ExitCb = (e: { exitCode: number | null }) => void

const dataSubs = new Map<string, Set<DataCb>>()
const exitSubs = new Map<string, Set<ExitCb>>()
const preBuffer = new Map<string, string[]>() // data that arrived before any subscriber (capped)
const PRE_MAX = 64 * 1024

/** App.tsx → here, when a 'terminal-data' os:action arrives. */
export function pushTerminalData(id: string, data: string): void {
  const subs = dataSubs.get(id)
  if (subs && subs.size) {
    for (const cb of subs) { try { cb(data) } catch { /* a bad terminal must not break the stream */ } }
    return
  }
  // no subscriber yet — buffer so a terminal that opens momentarily later still repaints recent output
  let buf = preBuffer.get(id)
  if (!buf) { buf = []; preBuffer.set(id, buf) }
  buf.push(data)
  let total = buf.reduce((n, s) => n + s.length, 0)
  while (total > PRE_MAX && buf.length > 1) total -= (buf.shift() as string).length
}

export function pushTerminalExit(id: string, exitCode: number | null): void {
  const subs = exitSubs.get(id)
  if (subs) for (const cb of subs) { try { cb({ exitCode }) } catch { /* ignore */ } }
}

/** TerminalView subscribes; gets any buffered pre-subscription data immediately. Returns an unsubscribe. */
export function subscribeTerminal(id: string, onData: DataCb, onExit?: ExitCb): () => void {
  let d = dataSubs.get(id); if (!d) { d = new Set(); dataSubs.set(id, d) }
  d.add(onData)
  const buf = preBuffer.get(id)
  if (buf && buf.length) { preBuffer.delete(id); try { onData(buf.join('')) } catch { /* ignore */ } }
  let e: Set<ExitCb> | undefined
  if (onExit) { e = exitSubs.get(id); if (!e) { e = new Set(); exitSubs.set(id, e) } e.add(onExit) }
  return () => {
    d!.delete(onData); if (!d!.size) dataSubs.delete(id)
    if (onExit && e) { e.delete(onExit); if (!e.size) exitSubs.delete(id) }
  }
}
