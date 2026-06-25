export const meta = {
  name: 'island-p0a',
  description: 'Scaffold + build + adversarially review the native BlitzIsland helper (P0a)',
  phases: [
    { title: 'Research', detail: 'specs from template + reference + WS pattern' },
    { title: 'Author', detail: 'write main.swift + Info.plist + entitlements + build.sh' },
    { title: 'Build', detail: 'swiftc compile loop until green' },
    { title: 'Review', detail: 'adversarial: recipe / swift-safety / WS / bundle' },
    { title: 'Fix', detail: 'apply confirmed findings, recompile' },
  ],
}

const ROOT = '/Users/minjunes/superapp/teenybase/agent-os'
const HELPER = ROOT + '/native/island-helper'
const TEMPLATE = ROOT + '/native/computer-use-helper'
const REF = '/Users/minjunes/superapp/teenybase/.repos/boring.notch'
const PLAN = ROOT + '/plans/blitzos-dynamic-island.md'

const RECIPE = `NSPanel subclass: isFloatingPanel=true, isOpaque=false, backgroundColor=.clear, hasShadow=false, isMovable=false, titleVisibility=.hidden, titlebarAppearsTransparent=true, isReleasedWhenClosed=false; level = .mainMenu + 3; collectionBehavior = [.fullScreenAuxiliary, .stationary, .canJoinAllSpaces, .ignoresCycle]; override canBecomeKey=false and canBecomeMain=false; AND set hidesOnDeactivate=false (CRITICAL: an NSPanel defaults hidesOnDeactivate=YES which would vanish the always-on island when another app is focused; this exact flag is the lesson from BlitzOS's launcher bug).`

const CONSTRAINTS = `HARD CONSTRAINTS:
- CLEAN ROOM: the reference at ${REF} is GPL-3.0. STUDY it to understand geometry/flags, then REIMPLEMENT from scratch. Do NOT copy its source. The NotchShape is simple geometry (a top-concave + bottom-rounded rounded-rect path); reimplement with NSBezierPath.
- PURE APPKIT, single file: no SwiftUI, no SPM, no external deps. It must compile with a single swiftc invocation (like ${TEMPLATE}/build.sh). Frameworks: AppKit, Foundation, CoreGraphics, QuartzCore, and Carbon (for RegisterEventHotKey).
- NO DISPLAY in this sandbox: never try to RUN the GUI app. The only test is that build.sh compiles it, produces native/island-helper/build/BlitzIsland.app, and codesign verifies (ad-hoc is fine here).
- Bundle id dev.blitz.os.island; executable BlitzIsland; LSUIElement=true (faceless .accessory agent); min macOS 13.0; arm64.`

const SPEC_SCHEMA = {
  type: 'object', required: ['area', 'spec'],
  properties: {
    area: { type: 'string' },
    spec: { type: 'string', description: 'Detailed, concrete implementation guidance the author will follow. Include exact API names, the values/constants, and code-shape notes.' },
    constants: { type: 'array', items: { type: 'string' }, description: 'concrete name=value constants' },
    pitfalls: { type: 'array', items: { type: 'string' } },
  },
}
const AUTHORED_SCHEMA = {
  type: 'object', required: ['files_written', 'summary'],
  properties: {
    files_written: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}
const BUILD_SCHEMA = {
  type: 'object', required: ['ok', 'errors'],
  properties: {
    ok: { type: 'boolean', description: 'true only if build.sh exited 0 AND build/BlitzIsland.app exists AND codesign -dvv succeeds' },
    command: { type: 'string' },
    errors: { type: 'string', description: 'the compiler/build error output, trimmed to the first ~40 relevant lines; empty if ok' },
    notes: { type: 'string' },
  },
}
const REVIEW_SCHEMA = {
  type: 'object', required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'title', 'detail', 'fix'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          title: { type: 'string' },
          detail: { type: 'string' },
          file: { type: 'string' },
          fix: { type: 'string', description: 'the concrete change to make' },
        },
      },
    },
  },
}

// ---------- Phase 1: research ----------
phase('Research')
const researchTemplate = `You are producing an implementation SPEC (not code) for the BUILD/BUNDLE of a new macOS Swift helper, BlitzIsland (P0a of ${PLAN}).
Read the existing template fully and report exactly how to clone it:
  ${TEMPLATE}/main.swift   (faceless .accessory agent, lifecycle, arg parsing)
  ${TEMPLATE}/build.sh     (swiftc invocation, bundle layout, Info.plist copy, icon, codesign ad-hoc fallback)
  ${TEMPLATE}/Info.plist
  ${TEMPLATE}/entitlements.plist
Output a concrete spec for: native/island-helper/build.sh (swiftc -O -target arm64-apple-macos13.0 with frameworks AppKit/Foundation/CoreGraphics/QuartzCore/Carbon, app name BlitzIsland, ad-hoc codesign fallback), Info.plist (bundle id dev.blitz.os.island, LSUIElement true, CFBundleExecutable BlitzIsland, LSMinimumSystemVersion 13.0), entitlements.plist (minimal valid plist; the island needs no TCC for P0 because the global hotkey uses Carbon RegisterEventHotKey, not a global NSEvent monitor), and a .gitignore (build/). ${CONSTRAINTS}`

const researchWindow = `You are producing an implementation SPEC (not code) for the WINDOW + notch geometry + shape + hover of the BlitzIsland helper (P0a of ${PLAN}; read the plan's "VERIFIED RECIPE" line).
Study (do NOT copy, GPL) these reference files to understand the technique, then specify a clean AppKit reimplementation:
  ${REF}/boringNotch/components/Notch/BoringNotchWindow.swift   (the panel flags/level/collectionBehavior/canBecomeKey)
  ${REF}/boringNotch/components/Notch/NotchShape.swift          (the concave-top/rounded-bottom path geometry)
  ${REF}/boringNotch/sizing/matters.swift                       (notch size + safeAreaInsets usage)
Specify, in concrete AppKit terms:
1. The NSPanel subclass with EXACTLY this recipe: ${RECIPE}
2. Notch geometry: how to read the notched screen's notch rect from NSScreen.main using safeAreaInsets (top inset = notch/menubar height) and auxiliaryTopLeftArea / auxiliaryTopRightArea (the gap between them = notch width). Fallback when there is no notch (no safe-area top): center a pill below the menu bar. Position the panel centered on the notch at the top of NSScreen.main.
3. A custom NSView that draws the collapsed island as an OPAQUE BLACK NotchShape via NSBezierPath (top-concave radius ~6, bottom-rounded radius ~14), reimplemented from the simple geometry (NOT copied).
4. Hover-to-expand: an NSTrackingArea (mouseEntered -> expand, mouseExited -> collapse) animating the panel frame larger to reveal an empty NSVisualEffectView glass panel below the pill. Collapsed = black pill; expanded = glass.
5. Reposition on NSApplication.didChangeScreenParametersNotification.
${CONSTRAINTS}`

const researchWs = `You are producing an implementation SPEC (not code) for the WebSocket client of the BlitzIsland helper (P0a of ${PLAN}).
The island connects to BlitzOS's localhost control server at a token-gated route. The control server writes its url + token to ~/.blitzos/session.json. Specify a clean Foundation reimplementation:
1. Read ~/.blitzos/session.json (JSON) for the control server's base url + token. Derive the WebSocket URL: take the http base, swap http->ws, append /island, and add ?token=<token>. Also accept --port and --token CLI args as an override (and a --connect <wsurl> override).
2. A URLSessionWebSocketTask client: connect, on open send a hello frame {t:"hello", token, pid, bundleId} as JSON text, then a receive loop that JSON-decodes each text frame and logs it (P0a has no real message handling yet; just the loop + a stub switch on a "t" field handling "ping" -> send {t:"pong"}).
3. Robustness: reconnect with backoff if the connection fails or drops (the server / route may not exist yet in P0a, so connection WILL fail; it must retry quietly, never crash). Keep all UI on the main thread.
4. JSON encode/decode helpers using JSONSerialization (no Codable structs needed for P0a).
Specify exact API calls (URLSession, webSocketTask(with:), .resume(), send(.string), receive). ${CONSTRAINTS}`

const specs = (await parallel([
  () => agent(researchTemplate, { label: 'research:template', phase: 'Research', schema: SPEC_SCHEMA }),
  () => agent(researchWindow, { label: 'research:window', phase: 'Research', schema: SPEC_SCHEMA }),
  () => agent(researchWs, { label: 'research:ws', phase: 'Research', schema: SPEC_SCHEMA }),
])).filter(Boolean)
log(`research: ${specs.length}/3 specs produced`)

// ---------- Phase 2: author ----------
phase('Author')
const specBlock = specs.map(s => `### ${s.area}\n${s.spec}\nCONSTANTS: ${(s.constants || []).join('; ')}\nPITFALLS: ${(s.pitfalls || []).join('; ')}`).join('\n\n')
const authorPrompt = `Write the BlitzIsland helper (P0a). Create these files with the Write tool (mkdir -p ${HELPER} first via Bash):
  ${HELPER}/main.swift
  ${HELPER}/Info.plist
  ${HELPER}/entitlements.plist
  ${HELPER}/build.sh   (chmod +x it)
  ${HELPER}/.gitignore (contains: build/)

Follow these specs from the research phase EXACTLY:

${specBlock}

main.swift must, in pure AppKit single-file Swift: be a faceless .accessory NSApplication; define the NSPanel subclass with the verified recipe (${RECIPE}); compute the notch rect from NSScreen.main (safeAreaInsets + auxiliaryTopLeftArea/auxiliaryTopRightArea, with a no-notch fallback) and position the panel centered at the top; draw the collapsed black NotchShape via NSBezierPath in a custom NSView (reimplemented, NOT copied from the GPL reference); hover-expand via NSTrackingArea to reveal an NSVisualEffectView glass panel; register a Carbon RegisterEventHotKey for Option+Space that toggles expand/collapse; run the URLSessionWebSocketTask client (read ~/.blitzos/session.json for url+token, build ws://.../island?token=, hello on open, receive loop with ping->pong, reconnect-with-backoff that never crashes when the server is absent); reposition on didChangeScreenParameters.

${CONSTRAINTS}

Do NOT run the app. Return the list of files you wrote and a short summary. The next phase compiles it.`
const authored = await agent(authorPrompt, { label: 'author', phase: 'Author', schema: AUTHORED_SCHEMA })
log(`authored: ${(authored && authored.files_written || []).join(', ')}`)

// ---------- Phase 3: build (compile-fix loop) ----------
phase('Build')
const buildPrompt = `Build the BlitzIsland helper and report honestly. Run:  bash ${HELPER}/build.sh 2>&1
Then verify:  test -d ${HELPER}/build/BlitzIsland.app && codesign -dvv ${HELPER}/build/BlitzIsland.app 2>&1
Set ok=true ONLY if build.sh exits 0 AND the .app exists AND codesign verifies. If it failed, put the actual swiftc/build error output in 'errors' (trim to the first ~40 relevant lines, keep the real error messages verbatim). Do not edit any files; just build and report.`
let build = await agent(buildPrompt, { label: 'build:1', phase: 'Build', schema: BUILD_SCHEMA })
let tries = 1
while (build && !build.ok && tries < 4) {
  const fixBuild = `The BlitzIsland build FAILED. Fix the source so it compiles. Errors:\n\n${build.errors}\n\nRead the files under ${HELPER}, diagnose the REAL cause (compile error, bad Carbon C-interop, framework, plist), and Edit to fix. Keep the verified window recipe and the clean-room rule intact. ${CONSTRAINTS} Do not run the app. Return the files you changed.`
  await agent(fixBuild, { label: `buildfix:${tries}`, phase: 'Build', schema: AUTHORED_SCHEMA })
  build = await agent(buildPrompt, { label: `build:${tries + 1}`, phase: 'Build', schema: BUILD_SCHEMA })
  tries++
}
log(`build after ${tries} attempt(s): ok=${build && build.ok}`)

// ---------- Phase 4: adversarial review (only if it compiles) ----------
phase('Review')
const LENSES = [
  { key: 'recipe', prompt: `Verify the NSPanel matches the VERIFIED RECIPE exactly: ${RECIPE}. Also verify the notch rect comes from NSScreen safeAreaInsets + auxiliaryTopLeftArea (not hardcoded), the NotchShape is concave-top/rounded-bottom, and it repositions on didChangeScreenParameters. Flag any deviation.` },
  { key: 'swift-safety', prompt: `Swift correctness lens: force-unwrap crash risks, UI work off the main thread, retain cycles in the WS/hover closures, the Carbon RegisterEventHotKey C-interop correctness (EventHotKeyID, InstallEventHandler, the callback), NSTrackingArea options. Anything that would crash or misbehave.` },
  { key: 'ws', prompt: `WebSocket-client lens: does it read ~/.blitzos/session.json url+token correctly, build a correct ws://.../island?token= URL, send hello on open, run a receive loop with ping->pong, and reconnect-with-backoff WITHOUT crashing or busy-looping when the server/route is absent (true for P0a)?` },
  { key: 'bundle', prompt: `Bundle/build lens: Info.plist (dev.blitz.os.island, LSUIElement true, CFBundleExecutable BlitzIsland, LSMinimumSystemVersion 13.0), entitlements minimal+valid, build.sh swiftc frameworks + ad-hoc codesign fallback + executable bit, .gitignore. AND verify CLEAN ROOM: no code copied from the GPL reference at ${REF} (the NotchShape must be an independent reimplementation).` },
]
let findings = []
if (build && build.ok) {
  const reviews = (await parallel(LENSES.map(L => () =>
    agent(`You are an adversarial reviewer of the BlitzIsland helper at ${HELPER}. Read main.swift / Info.plist / entitlements.plist / build.sh. ${L.prompt} Return concrete findings; prefer fewer, real ones over nitpicks. Default to NO finding if the code is correct.`,
      { label: `review:${L.key}`, phase: 'Review', schema: REVIEW_SCHEMA })
  ))).filter(Boolean)
  findings = reviews.flatMap(r => r.findings || []).filter(f => f.severity === 'blocker' || f.severity === 'major')
}
log(`review: ${findings.length} blocker/major findings`)

// ---------- Phase 5: fix + recompile ----------
phase('Fix')
let finalNote = 'no blocker/major findings'
if (findings.length) {
  const fixList = findings.map((f, i) => `${i + 1}. [${f.severity}] ${f.title} (${f.file || ''}): ${f.detail}\n   FIX: ${f.fix}`).join('\n')
  await agent(`Apply these confirmed findings to the BlitzIsland helper at ${HELPER}, then it must still compile. Findings:\n\n${fixList}\n\nEdit the files. Keep the verified recipe + clean-room rule. ${CONSTRAINTS} Return the files you changed.`,
    { label: 'fix', phase: 'Fix', schema: AUTHORED_SCHEMA })
  build = await agent(buildPrompt, { label: 'build:final', phase: 'Fix', schema: BUILD_SCHEMA })
  finalNote = `applied ${findings.length} findings; recompile ok=${build && build.ok}`
}

return {
  compile_ok: !!(build && build.ok),
  build_errors: (build && build.ok) ? '' : (build && build.errors || 'unknown'),
  build_attempts: tries,
  findings_applied: findings.length,
  files: (authored && authored.files_written) || [],
  note: finalNote,
}