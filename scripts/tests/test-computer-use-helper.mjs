// Smoke-test the BlitzOS computer-use helper's socket protocol (plans/blitzos-computer-use-helper.md).
// Headless: BlitzOS listens on a unix socket, launches the helper binary with --connect, drives the
// newline-JSON protocol. Verifies hello + ping + tcc_status shape (the live TCC GRANT + the
// LaunchServices identity are a packaged-build/user test — here we prove the wire protocol).
//   node scripts/test-computer-use-helper.mjs   (run native/computer-use-helper/build.sh first)
import net from 'node:net'
import { spawn } from 'node:child_process'
import { existsSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const bin = join(root, 'native/computer-use-helper/build/BlitzOS Automation.app/Contents/MacOS/BlitzOS Automation')
if (!existsSync(bin)) {
  console.error('FAIL: helper not built — run native/computer-use-helper/build.sh')
  process.exit(1)
}

const sockPath = join(tmpdir(), `blitz-cu-test-${process.pid}.sock`)
try {
  rmSync(sockPath, { force: true })
} catch {
  /* fresh */
}

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ok ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const pending = new Map()
const scanProgressHandlers = []
let nextId = 1
let helper = null
let buf = ''

function rpc(sock, cmd) {
  const id = nextId++
  return new Promise((resolve) => {
    pending.set(id, resolve)
    sock.write(JSON.stringify({ id, cmd }) + '\n')
  })
}

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
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.type === 'hello') helloResolve(msg)
      else if (msg.type === 'scan_progress') scanProgressHandlers.forEach((h) => h(msg))
      else if (msg.type === 'reply' && pending.has(msg.id)) {
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
      }
    }
  })
  void drive(sock, hello)
})

async function drive(sock, helloPromise) {
  const timeout = setTimeout(() => {
    check('helper responded within 8s', false, 'timeout')
    finish()
  }, 8000)

  const hello = await helloPromise
  check('hello received', !!hello, JSON.stringify(hello?.tcc))
  check('hello.bundleId is the helper', hello?.bundleId === 'dev.blitz.os.computeruse', hello?.bundleId)
  check('hello.tcc has both keys', hello?.tcc && 'accessibility' in hello.tcc && 'screenRecording' in hello.tcc)

  const pong = await rpc(sock, 'ping')
  check('ping → pong', pong?.pong === true)

  const status = await rpc(sock, 'tcc_status')
  check(
    'tcc_status shape (a11y/screen/fullDisk)',
    status?.tcc && typeof status.tcc.accessibility === 'boolean' && typeof status.tcc.screenRecording === 'boolean' && typeof status.tcc.fullDisk === 'boolean'
  )

  // scan: the helper runs a child process (here a fake scan), forwards @progress stderr, reports done.
  const fakeScan = join(tmpdir(), `blitz-cu-fakescan-${process.pid}.mjs`)
  const fakeOut = join(tmpdir(), `blitz-cu-fakescan-out-${process.pid}.json`)
  try {
    rmSync(fakeOut, { force: true })
  } catch {
    /* fresh */
  }
  writeFileSync(
    fakeScan,
    ["import {writeFileSync} from 'node:fs';", "process.stderr.write('@progress {\"phase\":\"begin\"}\\n');", `writeFileSync(${JSON.stringify(fakeOut)}, '{"ok":true}');`, 'process.exit(0);'].join('\n')
  )
  let scanProgress = 0
  const onProg = (m) => {
    if (m?.type === 'scan_progress') scanProgress++
  }
  scanProgressHandlers.push(onProg)
  const scan = await new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    sock.write(JSON.stringify({ id, cmd: 'scan', node: process.execPath, script: fakeScan, args: [], env: {} }) + '\n')
  })
  let scanOut = null
  try {
    scanOut = readFileSync(fakeOut, 'utf8')
  } catch {
    /* missing */
  }
  check('scan ran as helper child (exit 0 + output written)', scan?.ok === true && scanOut === '{"ok":true}', `exit=${scan?.exit} out=${scanOut}`)
  check('scan forwarded @progress', scanProgress >= 1)

  const shot = await rpc(sock, 'screenshot')
  // Headless / no grant → ok:false is acceptable; granted → a base64 PNG. Either is a valid reply.
  check('screenshot replied', shot && (shot.ok === true ? typeof shot.png === 'string' : typeof shot.error === 'string'), shot?.ok ? 'captured' : shot?.error)

  const bye = await rpc(sock, 'quit')
  check('quit acked', bye?.ok === true)

  clearTimeout(timeout)
  finish()
}

function finish() {
  try {
    server.close()
  } catch {
    /* already closed */
  }
  try {
    if (helper && !helper.killed) helper.kill()
  } catch {
    /* gone */
  }
  try {
    rmSync(sockPath, { force: true })
  } catch {
    /* gone */
  }
  if (failures) {
    console.error(`\n${failures} failure(s)`)
    process.exit(1)
  }
  console.log('\nall computer-use-helper protocol tests passed')
  process.exit(0)
}

server.listen(sockPath, () => {
  // Spawn the binary directly (the protocol test); the LaunchServices `open -a` path that gives the
  // helper its own TCC identity is exercised by the lifecycle manager (slice B) + a packaged build.
  helper = spawn(bin, ['--connect', sockPath], { stdio: 'ignore' })
  helper.on('error', (e) => {
    check('helper spawned', false, e.message)
    finish()
  })
})
