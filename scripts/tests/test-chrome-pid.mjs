// Verify the PID-pinned Chrome bridge (plans/blitzos-chrome-pid-targeting.md). BlitzOS listens on a unix socket,
// launches the helper, drives the newline-JSON protocol.
//   node native/computer-use-helper/build.sh && node scripts/tests/test-chrome-pid.mjs
//
// DETERMINISTIC proof (no Automation needed): `chrome_pid` shows that a given pid is EXCLUDED from selection — this
// is the exact mechanism that stops Blitz Chrome from shadowing the user's Chrome.
// BEST-EFFORT proof (needs the helper's Automation grant + Allow-JS): `chrome_list_tabs` + a benign `chrome_js`
// document.title read of the real Chrome, plus the collision proof (excluding one instance's pid).
import net from 'node:net'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const bin = join(root, 'native/computer-use-helper/build/BlitzOS Automation.app/Contents/MacOS/BlitzOS Automation')
if (!existsSync(bin)) {
  console.error('FAIL: helper not built — run native/computer-use-helper/build.sh')
  process.exit(1)
}
const sockPath = join(tmpdir(), `blitz-chrome-pid-${process.pid}.sock`)
try { rmSync(sockPath, { force: true }) } catch { /* fresh */ }

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ok ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const note = (s) => console.log(`  ··  ${s}`)

const pending = new Map()
let nextId = 1
let helper = null
let buf = ''

const server = net.createServer((sock) => {
  let helloResolve
  const hello = new Promise((r) => (helloResolve = r))
  sock.on('data', (d) => {
    buf += d.toString('utf8')
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.type === 'hello') helloResolve(msg)
      else if (msg.type === 'reply' && pending.has(msg.id)) {
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
      }
    }
  })
  void drive(sock, hello)
})

const rpc = (sock, cmd, args = {}) =>
  new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    sock.write(JSON.stringify({ id, cmd, ...args }) + '\n')
  })

async function drive(sock, helloPromise) {
  const timeout = setTimeout(() => { check('helper responded within 15s', false, 'timeout'); finish() }, 15000)
  const hello = await helloPromise
  check('hello received from the helper', hello?.bundleId === 'dev.blitz.os.computeruse', hello?.bundleId)

  // ---- DETERMINISTIC: pid selection + exclusion (no Apple Event, no Automation needed) ----
  const probe = await rpc(sock, 'chrome_pid', { excludePid: -1 })
  check('chrome_pid replies with shape {pid, candidates[]}', probe?.ok === true && Array.isArray(probe.candidates), JSON.stringify({ pid: probe?.pid, candidates: probe?.candidates }))
  const candidates = probe?.candidates || []

  if (candidates.length >= 1) {
    const victim = candidates[0]
    const excl = await rpc(sock, 'chrome_pid', { excludePid: victim })
    // The chosen pid must NEVER be the excluded one. With 1 candidate → -1 (the only instance was excluded); with
    // ≥2 → another candidate. Either way Blitz's pid can never be selected. THIS is the collision fix.
    const ok = excl?.pid !== victim
    check(`chrome_pid EXCLUDES pid ${victim} (the Blitz-shadow case)`, ok, `chosen=${excl?.pid} excluded=${victim}`)
    if (candidates.length >= 2) check('with ≥2 instances, excluding one still resolves a real user pid', excl?.pid > 0 && candidates.includes(excl.pid))
    else check('with the only instance excluded, resolves to none (-1)', excl?.pid === -1)
  } else {
    note('no com.google.Chrome running — exclusion test skipped; checking the honest no-Chrome result instead')
    const lt = await rpc(sock, 'chrome_list_tabs', { excludePid: -1 })
    check("no-Chrome → list returns reason 'no-user-chrome' (not a false permission/closed state)", lt?.ok === false && lt?.reason === 'no-user-chrome', JSON.stringify(lt))
  }

  // ---- BEST-EFFORT: the live ScriptingBridge path (needs Automation granted to THIS helper signature) ----
  const auth = await rpc(sock, 'automation_status', { bundleId: 'com.google.Chrome' })
  const granted = auth?.granted === true
  note(`Automation (control Google Chrome) for this helper: ${granted ? 'GRANTED' : 'not granted (status ' + auth?.status + ')'}`)

  if (granted && candidates.length >= 1) {
    const lt = await rpc(sock, 'chrome_list_tabs', { excludePid: -1 })
    check('chrome_list_tabs returns the user’s real tabs', lt?.ok === true && Array.isArray(lt.tabs), lt?.ok ? `${lt.tabs.length} tabs` : JSON.stringify(lt))

    // ---- OLD vs NEW: deterministically SHOW the collision when ≥2 com.google.Chrome instances are alive ----
    // OLD = `tell application "Google Chrome"` (bundle-id, ambiguous) → always lands on ONE instance.
    // NEW = PID-pinned → can address EACH instance distinctly. If OLD's instance != the one you wanted, that IS the bug.
    if (candidates.length >= 2) {
      const firstHttp = (r) => {
        const t = (r?.tabs || []).find((x) => /^https?:/i.test(String(x.url || ''))) || (r?.tabs || [])[0]
        return t ? `${String(t.title || t.url).slice(0, 48)} [id ${t.id}]` : '(none)'
      }
      const old = await rpc(sock, 'osa', { args: ['-e', 'tell application "Google Chrome"', '-e', 'set out to ""', '-e', 'repeat with w from 1 to count of windows', '-e', 'repeat with t from 1 to count of tabs of window w', '-e', 'try', '-e', 'set out to out & w & ":" & t & ":" & (URL of tab t of window w) & ":::" & (title of tab t of window w) & linefeed', '-e', 'end try', '-e', 'end repeat', '-e', 'end repeat', '-e', 'return out', '-e', 'end tell'] })
      const oldLines = String(old?.stdout || '').split('\n').filter(Boolean)
      let oldFirst = '(none)'
      for (const l of oldLines) { const m = l.match(/^\d+:\d+:(.*?):::(.*)$/); if (m && /^https?:/i.test(m[1])) { oldFirst = `${String(m[2] || m[1]).slice(0, 48)}`; break } }
      const [A, B] = candidates
      const onlyA = await rpc(sock, 'chrome_list_tabs', { excludePid: B }) // exclude B → pins to A
      const onlyB = await rpc(sock, 'chrome_list_tabs', { excludePid: A }) // exclude A → pins to B
      note(`OLD  tell-application "Google Chrome" → ${oldLines.length} tabs, first: ${oldFirst}  (lands on ONE instance, you don't control which)`)
      note(`NEW  pin pid ${A} → ${(onlyA?.tabs || []).length} tabs, first: ${firstHttp(onlyA)}`)
      note(`NEW  pin pid ${B} → ${(onlyB?.tabs || []).length} tabs, first: ${firstHttp(onlyB)}`)
      check('PID-pinning addresses EACH instance distinctly (old path cannot)', onlyA?.ok === true && onlyB?.ok === true)
      note('→ if the two instances above differ, OLD would intermittently hit the WRONG one — that is the shadow bug, now avoidable by excluding Blitz’s pid.')
    }
    const real = (lt?.tabs || []).find((t) => /^https?:/i.test(String(t.url || '')) && typeof t.id === 'number' && t.id >= 0)
    if (real) {
      note(`reading tab w${real.window}:t${real.tab} id=${real.id} — ${String(real.title || real.url).slice(0, 60)}`)
      // Benign, read-only: return the page title + href (no mutation). By window/tab index (the connect-time read).
      const js = await rpc(sock, 'chrome_js', { excludePid: -1, window: real.window, tab: real.tab, code: 'JSON.stringify({title:document.title,href:location.href})' })
      check('chrome_js by window/tab runs page JS + returns stable id (connect path)', js?.ok === true && typeof js.result === 'string' && js.tabId === real.id, js?.ok ? `tabId=${js.tabId}` : JSON.stringify(js))
      // By STABLE id — the path EVERY post-connect run_js/read/act/navigate uses. This is the one the envelope-id
      // collision broke; it must resolve the SAME tab regardless of its current window/tab position.
      const byId = await rpc(sock, 'chrome_js', { excludePid: -1, tabId: real.id, code: 'document.title' })
      check('chrome_js by stable tabId resolves the same tab (live connection path)', byId?.ok === true && typeof byId.result === 'string' && byId.tabId === real.id, byId?.ok ? `tabId=${byId.tabId}` : JSON.stringify(byId))
      // Collision proof: exclude this instance's pid → it must NOT be the source of the result.
      const victim = candidates[0]
      const excluded = await rpc(sock, 'chrome_list_tabs', { excludePid: victim })
      if (candidates.length >= 2) check(`excluding pid ${victim} still lists tabs (from another instance)`, excluded?.ok === true)
      else check(`excluding the only Chrome pid ${victim} → no-user-chrome (it is truly skipped)`, excluded?.ok === false && excluded?.reason === 'no-user-chrome', JSON.stringify(excluded))
    } else {
      note('no http(s) tab with a stable id to read — open a normal web page in Chrome to exercise chrome_js')
    }
  } else {
    note('skipping the live chrome_js read (would need Automation granted to this freshly-built helper signature)')
  }

  await rpc(sock, 'quit')
  clearTimeout(timeout)
  finish()
}

function finish() {
  try { server.close() } catch { /* already closed */ }
  try { if (helper && !helper.killed) helper.kill() } catch { /* gone */ }
  try { rmSync(sockPath, { force: true }) } catch { /* gone */ }
  if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1) }
  console.log('\nall chrome-pid checks passed')
  process.exit(0)
}

server.listen(sockPath, () => {
  helper = spawn(bin, ['--connect', sockPath], { stdio: 'ignore' })
  helper.on('error', (e) => { check('helper spawned', false, e.message); finish() })
})
