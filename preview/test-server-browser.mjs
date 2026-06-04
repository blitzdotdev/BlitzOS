// Verify the server-mode core against real headless Chromium:
// spawn → top-level target to a live site → screencast frames → control via the
// SHARED control-core (read / read selector / screenshot / type+read roundtrip).
import { controlSession } from '../src/main/control-core.mjs'
import { startBrowserHost } from './browser-host.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let frames = 0
let firstFrameBytes = 0

const host = await startBrowserHost({
  chromiumPath: process.env.CHROMIUM || '/usr/bin/chromium',
  onFrame: (sid, data) => {
    frames++
    if (frames === 1) firstFrameBytes = Buffer.from(data, 'base64').length
  }
})
console.log('[ok] browser host up')

await host.createSurface('t1', { url: 'https://example.com', width: 1024, height: 768 })
console.log('[ok] created web surface t1 -> https://example.com (top-level target)')

await sleep(2500) // let it load + stream a few frames
const sess = host.session('t1')

const title = await controlSession(sess, { action: 'read' })
console.log('[read]', JSON.stringify(title.result && { title: title.result.title, url: title.result.url, textHead: String(title.result.text).slice(0, 40) }))

const h1 = await controlSession(sess, { action: 'read', selector: 'h1' })
console.log('[read h1]', JSON.stringify(h1))

const shot = await controlSession(sess, { action: 'screenshot' })
console.log('[screenshot] ok=' + shot.ok + ' pngBytes=' + (shot.ok ? Buffer.from(shot.result, 'base64').length : '-'))

// input roundtrip: type into a contenteditable we inject, then read it back
await controlSession(sess, { action: 'eval', expression: "document.body.innerHTML = '<input id=q>'; document.getElementById('q').focus(); 'ready'" })
await controlSession(sess, { action: 'type', text: 'hello blitz', selector: '#q' })
const typed = await controlSession(sess, { action: 'eval', expression: "document.getElementById('q').value" })
console.log('[type roundtrip] typed value =', JSON.stringify(typed))

console.log(`[frames] received=${frames} firstFrameJpegBytes=${firstFrameBytes}`)

const pass =
  title.ok && /example/i.test(String(title.result?.title)) &&
  h1.ok && /example domain/i.test(String(h1.result)) &&
  shot.ok && Buffer.from(shot.result, 'base64').length > 1000 &&
  frames > 0 &&
  typed.ok && typed.result === 'hello blitz'

await host.closeSurface('t1')
await host.stop()
console.log(pass ? '\n✅ SERVER-MODE CORE VERIFIED' : '\n❌ SOMETHING FAILED — see above')
process.exit(pass ? 0 : 1)
