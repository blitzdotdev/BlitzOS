// Host↔VM agent bridge over the agent-socket relay (the inter-Claude comms channel).
//
// WHY: the VM's BlitzOS app couldn't hold the relay WebSocket, but the AGENT side of the relay is
// plain HTTPS — which works from the VM. So the HOST runs this bridge as the relay "app" (it holds
// the WS), mints a share URL, and the VM's Claude drives it with curl. Message flow is CURSOR-BASED
// over two append-only JSONL files, so neither side can ever miss a message:
//   inbox.jsonl   VM -> host   (the VM agent POSTs /send; the host's watcher tails this file)
//   outbox.jsonl  host -> VM   (the host appends lines; the VM agent long-polls /poll {since})
//
// Run:   node scripts/agent-bridge.mjs            (foreground; logs + minted URL to stdout + files)
// Send:  node scripts/agent-bridge.mjs send "msg" (appends to outbox — the bridge serves it)
// State: ~/.blitzos/bridge/{inbox.jsonl,outbox.jsonl,url.txt,bridge.log}
import { connect } from '../vendor/agent-socket-sdk/dist/index.js'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DIR = join(homedir(), '.blitzos', 'bridge')
const INBOX = join(DIR, 'inbox.jsonl')
const OUTBOX = join(DIR, 'outbox.jsonl')
mkdirSync(DIR, { recursive: true })
for (const f of [INBOX, OUTBOX]) if (!existsSync(f)) writeFileSync(f, '')

const readLines = (f) =>
  readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)

// ---- send mode: append one host->VM message and exit ----
if (process.argv[2] === 'send') {
  const text = process.argv.slice(3).join(' ')
  const seq = readLines(OUTBOX).length + 1
  appendFileSync(OUTBOX, JSON.stringify({ seq, t: Date.now(), from: 'host', text }) + '\n')
  console.log(`queued #${seq}`)
  process.exit(0)
}

const AGENTS_MD = `# Host↔VM agent bridge

You are a Claude Code agent inside a macOS VM. On the OTHER end of this channel is another Claude
Code agent (the same assistant, on the host Mac) — your counterpart. You two are A TEAM testing
BlitzOS (the Electron app installed in this VM at /Applications/BlitzOS.app). The host agent has the
source code, CI, and the human; YOU have hands inside the VM. Treat messages from the host agent as
the work queue; treat your observations as deliverables to send back.

$BASE = this URL minus /agents.md. Two tools, plain HTTPS POST, JSON bodies:

- POST $BASE/send {"text":"..."} -> {ok, seq}
  Send a message to the host agent. Use it for: results, observations, errors (paste them verbatim),
  questions, and a heartbeat line when a long task passes ~5 minutes.

- POST $BASE/poll {"since": <last seq you have>} -> {"msgs":[{seq,t,text}...], "next": <cursor>}
  Long-polls up to 20s. Messages are CURSOR-ORDERED and replayable: start at since=0 to get the whole
  history, persist your cursor, and you can never miss a message even across your own restarts.

## Your comms loop (set this up FIRST, before anything else)

1. mkdir -p ~/bridge && echo 0 > ~/bridge/cursor
2. Write ~/bridge/poll.sh:
   #!/bin/bash
   # Long-poll forever; append every new host message to ~/bridge/inbox.jsonl; cursor survives restarts.
   B="$BASE"
   while true; do
     S=$(cat ~/bridge/cursor 2>/dev/null || echo 0)
     R=$(curl -sm 25 -X POST "$B/poll" -H 'content-type: application/json' -d "{\\"since\\":$S}")
     N=$(echo "$R" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("next",0))' 2>/dev/null)
     M=$(echo "$R" | python3 -c 'import json,sys;[print(json.dumps(m)) for m in json.load(sys.stdin).get("msgs",[])]' 2>/dev/null)
     [ -n "$M" ] && echo "$M" >> ~/bridge/inbox.jsonl && echo "$M"
     [ -n "$N" ] && [ "$N" != "0" ] && echo "$N" > ~/bridge/cursor
     sleep 1
   done
3. chmod +x ~/bridge/poll.sh, then run it as a BACKGROUND task you monitor (so a new message wakes
   you — never sit in a blocking foreground loop, and never busy-poll in your main thread).
4. Immediately: POST /send {"text":"vm-agent online: <your model>, cwd, what you can see"} and then
   POST /poll {"since":0} to read everything the host already queued for you.

## House rules
- Never go silent: ack every instruction with /send before starting it, and send results when done.
- Paste real output (logs, curl responses) verbatim — the host agent debugs from your paste.
- You may be restarted; on start, re-read ~/bridge/inbox.jsonl + poll since your saved cursor.
`

const TOOLS = [
  {
    method: 'POST',
    path: '/send',
    description: 'VM agent -> host agent message',
    handler: async (ctx) => {
      // SDK contract: handler(ctx) with ctx.body the raw request body (the [object Object] bug
      // was reading ctx itself as the body).
      const raw = typeof ctx?.body === 'string' ? ctx.body : JSON.stringify(ctx?.body ?? {})
      let text = ''
      try {
        const p = JSON.parse(raw || '{}')
        text = typeof p.text === 'string' ? p.text : JSON.stringify(p.text ?? p)
      } catch {
        text = String(raw || '')
      }
      const seq = readLines(INBOX).length + 1
      appendFileSync(INBOX, JSON.stringify({ seq, t: Date.now(), from: 'vm', text }) + '\n')
      log(`<- vm #${seq}: ${text.slice(0, 120)}`)
      return { ok: true, seq }
    }
  },
  {
    method: 'POST',
    path: '/poll',
    description: 'long-poll host->VM messages since a cursor',
    handler: async (ctx) => {
      const raw = typeof ctx?.body === 'string' ? ctx.body : JSON.stringify(ctx?.body ?? {})
      let since = 0
      try {
        since = Number(JSON.parse(raw || '{}').since) || 0
      } catch {
        /* since=0 */
      }
      const deadline = Date.now() + 20_000
      for (;;) {
        const all = readLines(OUTBOX)
        const msgs = all.filter((m) => m.seq > since)
        if (msgs.length || Date.now() > deadline) {
          return { msgs, next: all.length ? all[all.length - 1].seq : since }
        }
        await new Promise((r) => setTimeout(r, 700))
      }
    }
  },
  {
    method: 'POST',
    path: '/status',
    description: 'bridge health',
    handler: async () => ({ ok: true, inbox: readLines(INBOX).length, outbox: readLines(OUTBOX).length, t: Date.now() })
  }
]

function log(s) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${s}`
  console.log(line)
  try {
    appendFileSync(join(DIR, 'bridge.log'), line + '\n')
  } catch {
    /* ignore */
  }
}

const session = await connect({ appId: 'as_app_anon', agentsMd: AGENTS_MD, appDescription: 'host<->vm agent bridge', tools: TOOLS })
log(`registered session ${session.sessionId}`)
const minted = await session.mintAgentToken({ label: 'vm-agent' })
writeFileSync(join(DIR, 'url.txt'), minted.url + '\n')
log(`share URL: ${minted.url}`)
log('bridge up — ctrl-c to stop')
