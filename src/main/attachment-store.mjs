// Per-message attachment SNAPSHOTS, persisted beside the chat file so the frozen dropbox copy shown above a sent
// message survives a full quit/restart. One JSON per chat: `<ws>/.blitzos/attachments/<chat>.json = { "<msgKey>":
// TrayGroup[] }`, keyed by String(sendTs) — the timestamp the renderer generates at send time and passes to main so
// both sides use the exact same value. Using the timestamp instead of a positional ordinal makes lookups stable
// across the sliding 400-message display window. Base64 icons are inlined (a few KB each; chat-scale). Renderer
// reaches this over IPC only (os:attach-get / os:attach-record), like the connection ops.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { markWrite as defaultMarkWrite } from './workspace.mjs'

// chat id → filesystem-safe basename ('0' → '0', '3' → '3'; harden against anything hand-edited).
function safeChat(chat) {
  return String(chat || '0').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || '0'
}

export function makeAttachmentStore({ getWorkspacePath = () => null, markWrite = defaultMarkWrite } = {}) {
  function fileFor(chat) {
    const ws = getWorkspacePath()
    if (!ws) return null
    const dir = join(ws, '.blitzos', 'attachments')
    return { dir, file: join(dir, safeChat(chat) + '.json') }
  }
  function read(file) {
    try {
      const obj = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
      return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {}
    } catch {
      return {}
    }
  }
  // All frozen snapshots for a chat: { "<msgKey>": TrayGroup[] }. Missing workspace/file → empty (never throws).
  function listAttachments(chat) {
    const f = fileFor(chat)
    return { attachments: f ? read(f.file) : {} }
  }
  // Freeze one message's tray. Merges into the chat's file (other keys untouched).
  function recordAttachments(chat, msgKey, groups) {
    const f = fileFor(chat)
    if (!f) return { error: 'no active workspace to persist attachments into' }
    const cur = read(f.file)
    cur[String(msgKey)] = Array.isArray(groups) ? groups : []
    try {
      mkdirSync(f.dir, { recursive: true })
      markWrite(f.dir)
      writeFileSync(f.file, JSON.stringify(cur))
      markWrite(f.file)
    } catch (e) {
      return { error: String((e && e.message) || e) }
    }
    return { ok: true }
  }
  return { listAttachments, recordAttachments }
}
