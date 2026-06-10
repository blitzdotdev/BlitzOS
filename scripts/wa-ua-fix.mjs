// One-shot live fix: override the headless Chromium's "HeadlessChrome" user-agent on the
// WhatsApp Web target with a clean desktop-Chrome UA (string + client-hint metadata) and
// reload, so WhatsApp's browser sniff passes and the login QR renders. No server restart.
// Run: node scripts/wa-ua-fix.mjs
import { readFileSync } from 'node:fs'
import { WebSocket } from 'ws'

const PROFILE = '/Users/palash/Projects/teeny/packages/BlitzOS/.blitz-chrome-profile'
const PORT = readFileSync(`${PROFILE}/DevToolsActivePort`, 'utf8').split('\n')[0].trim()

const VER = '147.0.7727.116'
const UA = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${VER} Safari/537.36`
const META = {
  brands: [
    { brand: 'Not)A;Brand', version: '8' },
    { brand: 'Chromium', version: '147' },
    { brand: 'Google Chrome', version: '147' }
  ],
  fullVersion: VER,
  fullVersionList: [
    { brand: 'Not)A;Brand', version: '8.0.0.0' },
    { brand: 'Chromium', version: VER },
    { brand: 'Google Chrome', version: VER }
  ],
  platform: 'Linux',
  platformVersion: '6.8.0',
  architecture: 'x86',
  model: '',
  mobile: false,
  bitness: '64',
  wow64: false
}

const targets = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json())
const wa = targets.find((t) => t.type === 'page' && /web\.whatsapp\.com/.test(t.url || ''))
if (!wa) {
  console.error('NO_WHATSAPP_TARGET')
  process.exit(2)
}
console.log('target:', wa.webSocketDebuggerUrl)

const ws = new WebSocket(wa.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const myId = ++id
    pending.set(myId, { resolve, reject })
    ws.send(JSON.stringify({ id: myId, method, params }))
  })

ws.on('message', (buf) => {
  const m = JSON.parse(buf.toString())
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? reject(new Error(m.error.message)) : resolve(m.result)
  }
})

await new Promise((res, rej) => {
  ws.once('open', res)
  ws.once('error', rej)
})

await send('Network.enable')
await send('Emulation.setUserAgentOverride', { userAgent: UA, userAgentMetadata: META })
await send('Network.setUserAgentOverride', { userAgent: UA, userAgentMetadata: META })
await send('Page.enable')
console.log('UA overridden; reloading WhatsApp Web...')
await send('Page.navigate', { url: 'https://web.whatsapp.com/' })

// Hold the connection open so the page's initial document + subresource loads use the
// override (it is tied to this client session). WhatsApp's QR render + post-scan handshake
// happen in-page without a re-sniff, so the override only needs to survive the first load.
await new Promise((r) => setTimeout(r, 8000))
console.log('done')
ws.close()
process.exit(0)
