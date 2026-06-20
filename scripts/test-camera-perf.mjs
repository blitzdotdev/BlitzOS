// test-camera-perf.mjs — guards the canvas pan/zoom perf fix. The camera transform is zustand state bound to the
// .world inline style, so driving a 60-120Hz trackpad gesture through it re-rendered all of App per event (jank).
// The fix: cameraController.ts drives the transform IMPERATIVELY (one rAF DOM write per frame) during a gesture
// and commits to the store ONCE on settle. These asserts keep a future edit from re-routing gestures back through
// per-event setState (the regression) or breaking the load-bearing pieces (freeze gate, zoom math, will-change,
// the zero-frame dual-writer reassert, the settle commits). Run: node scripts/test-camera-perf.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const cam = readFileSync(join(repoRoot, 'src/renderer/src/cameraController.ts'), 'utf8')
const app = readFileSync(join(repoRoot, 'src/renderer/src/App.tsx'), 'utf8')
const store = readFileSync(join(repoRoot, 'src/renderer/src/store.ts'), 'utf8')

let failures = 0
function ok(label, cond, detail) {
  if (cond) console.log(`  ✓ ${label}`)
  else {
    failures++
    console.log(`  ✗ ${label}`)
    if (detail !== undefined) console.log(`      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  }
}

console.log('Canvas camera perf (imperative pan/zoom):')

// ── cameraController.ts owns the imperative pipeline ─────────────────────────────────────────────────────────
ok('controller exports useCameraController + a liveCam ref',
  /export function useCameraController\(/.test(cam) && /liveCam = useRef/.test(cam))
ok('it writes the transform IMPERATIVELY via requestAnimationFrame (one DOM write per frame, no setState)',
  /requestAnimationFrame/.test(cam) && /worldRef\.current\)?\s*\n?\s*.*style\.transform =/.test(cam) || /el\.style\.transform = worldStr/.test(cam))
ok('it COMMITS to the store once via setTransform (not per event)',
  /useDesktop\.getState\(\)\.setTransform\(\{ \.\.\.liveCam\.current \}\)/.test(cam))
ok('the freeze lock is ported verbatim (panBy AND zoomAt no-op while locked)',
  (cam.match(/if \(useDesktop\.getState\(\)\.locked\) return/g) || []).length >= 2)
ok('the cursor-anchored zoom math + clamp(0.2,3) is ported from store.zoomAt',
  /Math\.exp\(-deltaY \* 0\.006\)/.test(cam) && /clamp\(scale \* factor, 0\.2, 3\)/.test(cam))
ok('will-change is managed here (set transform on motion, drop to auto after settle)',
  /willChange = 'transform'/.test(cam) && /willChange = 'auto'/.test(cam))
ok('it resyncs on EXTERNAL transform changes (one-shot flies) via a store subscription guarded by the committing flag',
  /useDesktop\.subscribe\(/.test(cam) && /if \(committing\.current\) return/.test(cam))
ok('wheel has no pointerup, so a debounce settles it; grab-pan commits on its real end',
  /setTimeout\(commit, SETTLE_MS\)/.test(cam) && /endPointerGesture/.test(cam))
// ── review fixes: external fly wins mid-gesture (no clobber) + fresh camera for one-shot screen->world reads ──
ok('an EXTERNAL fly is adopted even MID-gesture (cancels the gesture so its settle cannot clobber the fly)',
  /if \(committing\.current\) return/.test(cam) &&
    /if \(gesturing\.current\) \{[\s\S]{0,140}gesturing\.current = false[\s\S]{0,120}clearTimeout\(settleTimer\.current\)/.test(cam))
ok('our own commit is tagged (committing flag) so its setTransform does not re-enter the subscription as external',
  /committing\.current = true/.test(cam) && /committing\.current = false/.test(cam))
ok('cam.flush() commits a pending gesture, and the one-shot screen->world readers (drop/menu/radial) call it for a fresh camera',
  /flush: \(\) => \{\s*if \(gesturing\.current\) commit\(\)/.test(cam) && (app.match(/cam\.flush\(\)/g) || []).length >= 3)

// ── App.tsx routes gestures through the controller, keeps the subscription, adds the dual-writer fix ─────────
ok('App imports + instantiates the controller (cam = useCameraController(worldRef))',
  /import \{ useCameraController \} from '\.\/cameraController'/.test(app) && /const cam = useCameraController\(worldRef\)/.test(app))
ok('the App-wide transform subscription STAYS (the .world JSX + persistence still use it)',
  /const transform = useDesktop\(\(s\) => s\.transform\)/.test(app) && /style=\{\{ transform: `translate/.test(app))
ok('the zero-frame dual-writer fix: a no-dep useLayoutEffect re-asserts the live transform mid-gesture',
  /useLayoutEffect\(\(\) => \{\s*if \(cam\.isGesturing\(\)\) cam\.reassert\(\)\s*\}\)/.test(app))
ok('the WHEEL gesture goes through the controller (cam.panBy / cam.zoomAt), NOT per-event store setState',
  /cam\.panBy\(-e\.deltaX, -e\.deltaY\)/.test(app) && /cam\.zoomAt\(e\.clientX, e\.clientY, e\.deltaY\)/.test(app) &&
    !/w\.panBy\(/.test(app) && !/w\.zoomAt\(/.test(app))
ok('the GRAB-pan goes through the controller (onBgMove cam.panBy) + commits on pointerup (onBgUp cam.endPointerGesture)',
  /cam\.panBy\(e\.clientX - pan\.current\.x/.test(app) && /cam\.endPointerGesture\(\)/.test(app) &&
    !/getState\(\)\.panBy\(/.test(app))
ok('onBgDown re-seeds the controller (cam.sync) so the first pan move starts from the committed value',
  /cam\.sync\(\)/.test(app))
ok('the old per-transform willChange effect is GONE from App (its job moved into the controller)',
  !/\}, \[transform\]\)/.test(app))

// ── store.ts keeps panBy/zoomAt as the canonical math reference (no interface churn) ─────────────────────────
ok('store still declares panBy + zoomAt (kept as canonical reference; gestures route through the controller)',
  /panBy: \(dx, dy\) =>/.test(store) && /zoomAt: \(cursorX, cursorY, deltaY\) =>/.test(store) &&
    /go through cameraController\.ts/.test(store))

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
