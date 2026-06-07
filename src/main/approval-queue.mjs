// #51 — the write-approval queue: tracks concurrent pending approvals by id, each resolved exactly once
// (human approve/deny, or expiry → deny), clearing its timer on settle. Pure + transport-agnostic (no
// electron), so the concurrency correctness is headless-testable; provider-bridge.ts wires the real
// ledger + the renderer broadcast into it. The renderer shows a card per pending id and answers each.
export function createApprovalQueue({
  ledger,
  broadcast,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (h) => clearTimeout(h)
} = {}) {
  const pending = new Map() // approvalRequest.id -> { resolve, timer }

  // Resolve a pending approval EXACTLY once and clear its expiry timer (no orphan timer, no double-resolve).
  function settle(id, token) {
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    clearTimer(p.timer)
    p.resolve(token)
  }

  // Register a pending write, broadcast the card, and resolve to a token (approve) or null (deny/expiry).
  function request(req) {
    return new Promise((resolve) => {
      const ms = Math.max(1000, req.expiresAt - now())
      const timer = setTimer(() => settle(req.id, null), ms) // expiry → denied
      pending.set(req.id, { resolve, timer })
      broadcast({ type: 'provider-approval', request: req })
    })
  }

  return {
    request,
    // the renderer (consent authority) approves → mint the request-bound token from the ledger.
    approve: (id) => settle(id, ledger.approve(id, now())),
    deny: (id) => settle(id, null),
    pendingCount: () => pending.size
  }
}
