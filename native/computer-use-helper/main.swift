// BlitzOS — the separate, Developer-ID-signed background helper that HOLDS the
// computer-use TCC grants (Accessibility + Screen Recording) so BlitzOS never has to quit and
// reopen for them (plans/blitzos-computer-use-helper.md). Launched by BlitzOS via LaunchServices
// (`open -a`) so it is its OWN responsible process with its OWN TCC identity, distinct from the
// BlitzOS/Electron app. It connects back to a Unix domain socket BlitzOS owns and speaks a
// newline-delimited JSON protocol.
//
// Capabilities here are deliberately minimal-but-real: report + request the two TCC grants, and a
// CGDisplayCreateImage screenshot that PROVES the Screen-Recording grant lands on the helper.
// ScreenCaptureKit + AX-driven clicking are the executor's job when the computer-use feature lands.

import Foundation
import AppKit
import CoreGraphics
import ApplicationServices
import ScreenCaptureKit

// The live connection to BlitzOS — assigned in main(), referenced by the AXObserver C callback (which can't
// capture Swift context, so it reads this global).
var conn: HelperConnection!

// ---- tiny JSON helpers (no external deps) --------------------------------------------------
func jsonLine(_ obj: [String: Any]) -> Data {
    let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8)
    var line = data
    line.append(0x0A) // newline-delimited
    return line
}

// ---- TCC status + requests (attributed to THIS bundle, the whole point) --------------------
func accessibilityGranted() -> Bool { AXIsProcessTrusted() }
func screenRecordingGranted() -> Bool { CGPreflightScreenCaptureAccess() }

func requestAccessibility() {
    // Raises the system prompt AND lists this app under Accessibility (the drag is the fallback).
    let opt = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as NSString
    _ = AXIsProcessTrustedWithOptions([opt: true] as CFDictionary)
}
func requestScreen() {
    // Raises the Screen-Recording prompt + lists this app. (Async grant; the poll catches it.)
    CGRequestScreenCaptureAccess()
}

// Full Disk Access: there is no API, so probe a TCC-only file (the canonical TCC.db). EPERM/EACCES
// = denied. This reads THIS process's (the helper's) FDA — which is the whole point: FDA lands on
// the helper, not BlitzOS, so granting it restarts only the helper.
func fullDiskGranted() -> Bool {
    let home = NSHomeDirectory()
    let probes = [
        "\(home)/Library/Application Support/com.apple.TCC/TCC.db",
        "\(home)/Library/Safari/History.db"
    ]
    for p in probes {
        if let fh = FileHandle(forReadingAtPath: p) {
            _ = try? fh.read(upToCount: 1)
            try? fh.close()
            return true
        }
    }
    return false
}

func tccStatus() -> [String: Any] {
    ["accessibility": accessibilityGranted(), "screenRecording": screenRecordingGranted(), "fullDisk": fullDiskGranted()]
}

// PROOF the Screen-Recording grant works on the helper: capture the main display to a base64 PNG.
func screenshotBase64() -> String? {
    let displayID = CGMainDisplayID()
    guard let image = CGDisplayCreateImage(displayID) else { return nil }
    let rep = NSBitmapImageRep(cgImage: image)
    guard let png = rep.representation(using: .png, properties: [:]) else { return nil }
    return png.base64EncodedString()
}

// Run the onboarding scan AS A CHILD of the helper. The child's responsible process is the helper
// (a LaunchServices app, its own TCC identity), so the scan reads Messages/Mail/Safari with the
// HELPER's Full Disk Access — never BlitzOS's. BlitzOS reads the scan's OUTPUT files; the helper
// only forwards the scan's stderr (@progress lines) so the boot bar stays live, then replies done.
func runScan(_ conn: HelperConnection, id: Int, node: String, script: String, args: [String], env: [String: String]) {
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: node)
    proc.arguments = [script] + args
    var e = ProcessInfo.processInfo.environment
    for (k, v) in env { e[k] = v }
    proc.environment = e
    let errPipe = Pipe()
    proc.standardError = errPipe
    proc.standardOutput = FileHandle.nullDevice
    var errBuf = Data()
    errPipe.fileHandleForReading.readabilityHandler = { fh in
        let d = fh.availableData
        if d.isEmpty { return }
        errBuf.append(d)
        while let nl = errBuf.firstIndex(of: 0x0A) {
            let line = String(data: errBuf.subdata(in: errBuf.startIndex..<nl), encoding: .utf8) ?? ""
            errBuf.removeSubrange(errBuf.startIndex...nl)
            conn.send(["type": "scan_progress", "id": id, "line": line])
        }
    }
    proc.terminationHandler = { p in
        errPipe.fileHandleForReading.readabilityHandler = nil
        conn.send(["type": "reply", "id": id, "ok": p.terminationStatus == 0, "exit": Int(p.terminationStatus)])
    }
    do {
        try proc.run()
    } catch {
        conn.send(["type": "reply", "id": id, "ok": false, "error": "scan spawn failed: \(error)"])
    }
}

// Like runScan but CAPTURES stdout (runScan discards it). The browser CONNECTION tools run their AppleScript
// THROUGH this, so the "control Chrome/Safari" Automation grant lives on the HELPER (granted once in onboarding),
// not on BlitzOS — otherwise driving the browser in chat re-prompts on the Electron app. Drains both pipes
// concurrently (no 64KB deadlock) and replies {ok=(exit==0), stdout, stderr, exit}.
func runOsa(_ conn: HelperConnection, id: Int, args: [String]) {
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    proc.arguments = args
    let outPipe = Pipe()
    let errPipe = Pipe()
    proc.standardOutput = outPipe
    proc.standardError = errPipe
    do {
        try proc.run()
    } catch {
        conn.send(["type": "reply", "id": id, "ok": false, "error": "osa spawn failed: \(error)"])
        return
    }
    let group = DispatchGroup()
    var outData = Data()
    var errData = Data()
    group.enter()
    DispatchQueue.global().async { outData = outPipe.fileHandleForReading.readDataToEndOfFile(); group.leave() }
    group.enter()
    DispatchQueue.global().async { errData = errPipe.fileHandleForReading.readDataToEndOfFile(); group.leave() }
    group.notify(queue: .global()) {
        proc.waitUntilExit()
        conn.send(["type": "reply", "id": id, "ok": proc.terminationStatus == 0, "exit": Int(proc.terminationStatus),
                   "stdout": String(data: outData, encoding: .utf8) ?? "", "stderr": String(data: errData, encoding: .utf8) ?? ""])
    }
}

// ===== Computer-use: window enumeration + AX (read/act) + vision (per-window screenshot) + CGEvent input =====
// The WINDOW adapter for BlitzOS connections. AX read/act work on BACKGROUND windows; coordinate input +
// per-window screenshots are the "vision" path for apps AX can't read (needs the window raised/visible).

func axApp(_ pid: Int) -> AXUIElement { AXUIElementCreateApplication(pid_t(pid)) }
func axAttr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var val: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name as CFString, &val) == .success ? val : nil
}
func axStr(_ el: AXUIElement, _ name: String) -> String? { axAttr(el, name) as? String }
func axActions(_ el: AXUIElement) -> [String] {
    var arr: CFArray?
    return AXUIElementCopyActionNames(el, &arr) == .success ? ((arr as? [String]) ?? []) : []
}
func axChildren(_ el: AXUIElement) -> [AXUIElement] { (axAttr(el, kAXChildrenAttribute as String) as? [AXUIElement]) ?? [] }
// Chromium/Electron expose an empty AX tree until a client sets AXManualAccessibility — set it + retry.
func axEnableManual(_ app: AXUIElement) { AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue) }

func axNode(_ el: AXUIElement, depth: Int, maxDepth: Int, counter: inout Int, limit: Int) -> [String: Any] {
    counter += 1
    var node: [String: Any] = [:]
    if let role = axStr(el, kAXRoleAttribute as String) { node["role"] = role }
    if let title = axStr(el, kAXTitleAttribute as String), !title.isEmpty { node["title"] = String(title.prefix(120)) }
    if let v = axAttr(el, kAXValueAttribute as String) {
        if let s = v as? String, !s.isEmpty { node["value"] = String(s.prefix(200)) }
        else if let n = v as? NSNumber { node["value"] = n }
    }
    if let desc = axStr(el, kAXDescriptionAttribute as String), !desc.isEmpty { node["desc"] = String(desc.prefix(120)) }
    let acts = axActions(el)
    if !acts.isEmpty { node["actions"] = acts }
    if depth < maxDepth && counter < limit {
        var arr: [[String: Any]] = []
        for c in axChildren(el) {
            if counter >= limit { break }
            arr.append(axNode(c, depth: depth + 1, maxDepth: maxDepth, counter: &counter, limit: limit))
        }
        if !arr.isEmpty { node["children"] = arr }
    }
    return node
}
func axTree(pid: Int, maxDepth: Int, limit: Int) -> [String: Any] {
    let app = axApp(pid)
    axEnableManual(app)
    var counter = 0
    let wins = (axAttr(app, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
    if wins.isEmpty { return ["root": axNode(app, depth: 0, maxDepth: maxDepth, counter: &counter, limit: limit), "nodes": counter] }
    var windows: [[String: Any]] = []
    for w in wins {
        if counter >= limit { break }
        windows.append(axNode(w, depth: 0, maxDepth: maxDepth, counter: &counter, limit: limit))
    }
    return ["windows": windows, "nodes": counter]
}
// BFS for the first element matching role (+ optional title/description substring).
func axFind(_ root: AXUIElement, role: String?, title: String?, limit: Int = 5000) -> AXUIElement? {
    var queue = [root]
    var seen = 0
    while !queue.isEmpty && seen < limit {
        let el = queue.removeFirst()
        seen += 1
        let r = axStr(el, kAXRoleAttribute as String)
        let t = axStr(el, kAXTitleAttribute as String) ?? axStr(el, kAXDescriptionAttribute as String)
        let roleOk = role == nil || r == role
        let titleOk = title == nil || (t?.localizedCaseInsensitiveContains(title!) ?? false)
        if (role != nil || title != nil) && roleOk && titleOk { return el }
        queue.append(contentsOf: axChildren(el))
    }
    return nil
}
func axAct(pid: Int, find: [String: Any], action: String, value: String?) -> [String: Any] {
    let app = axApp(pid)
    axEnableManual(app)
    let roots = (axAttr(app, kAXWindowsAttribute as String) as? [AXUIElement]) ?? [app]
    var target: AXUIElement?
    for root in roots {
        if let el = axFind(root, role: find["role"] as? String, title: find["title"] as? String) { target = el; break }
    }
    guard let el = target else { return ["error": "no AX element matching \(find)"] }
    if action == "setValue" {
        let r = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, (value ?? "") as CFString)
        return r == .success ? ["effect": ["value": axStr(el, kAXValueAttribute as String) ?? value ?? ""]] : ["error": "setValue failed (\(r.rawValue))"]
    }
    let act = (action == "press" || action.isEmpty) ? (kAXPressAction as String) : action
    let before = axStr(el, kAXValueAttribute as String)
    let r = AXUIElementPerformAction(el, act as CFString)
    return r == .success ? ["effect": ["action": act, "before": before ?? ""]] : ["error": "AX action \(act) failed (\(r.rawValue))"]
}

func listWindows() -> [[String: Any]] {
    let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let infos = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { return [] }
    var out: [[String: Any]] = []
    var iconByPid: [Int: String] = [:] // one icon encode per app, reused across its windows
    for info in infos {
        if (info[kCGWindowLayer as String] as? Int) ?? 0 != 0 { continue } // normal app windows only
        let wid = (info[kCGWindowNumber as String] as? Int) ?? 0
        let pid = (info[kCGWindowOwnerPID as String] as? Int) ?? 0
        let app = (info[kCGWindowOwnerName as String] as? String) ?? ""
        let title = (info[kCGWindowName as String] as? String) ?? ""
        let bounds = (info[kCGWindowBounds as String] as? [String: Any]) ?? [:]
        let bundleId = NSRunningApplication(processIdentifier: pid_t(pid))?.bundleIdentifier ?? ""
        let icon: String
        if let cached = iconByPid[pid] { icon = cached } else { icon = pickIconBase64(pid); iconByPid[pid] = icon }
        out.append(["windowId": wid, "pid": pid, "app": app, "bundleId": bundleId, "title": title, "bounds": bounds, "icon": icon])
    }
    return out
}

// per-window screenshot via ScreenCaptureKit (macOS 14+). No CGWindowListCreateImage (removed in the 15 SDK).
@available(macOS 14.0, *)
func windowShot(windowId: Int, reply: @escaping ([String: Any]) -> Void) {
    func done(_ r: [String: Any]) { DispatchQueue.main.async { reply(r) } }
    Task {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            guard let win = content.windows.first(where: { Int($0.windowID) == windowId }) else { done(["error": "window \(windowId) not found"]); return }
            let filter = SCContentFilter(desktopIndependentWindow: win)
            let cfg = SCStreamConfiguration()
            cfg.width = max(1, Int(win.frame.width) * 2)
            cfg.height = max(1, Int(win.frame.height) * 2)
            let cg = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
            guard let png = NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:]) else { done(["error": "png encode failed"]); return }
            done(["ok": true, "png": png.base64EncodedString(), "width": cg.width, "height": cg.height,
                  "frame": ["x": win.frame.origin.x, "y": win.frame.origin.y, "w": win.frame.width, "h": win.frame.height]])
        } catch {
            done(["error": "capture failed: \(error)"])
        }
    }
}

// Map a pick to a GLOBAL screen point: either {x,y} (already points) or {windowId,px,py} (pixels in the
// window screenshot → divide by the backing scale, offset by the window origin).
func cgPoint(windowId: Int?, px: Double?, py: Double?, x: Double?, y: Double?) -> CGPoint? {
    if let x = x, let y = y { return CGPoint(x: x, y: y) }
    guard let wid = windowId, let px = px, let py = py,
          let infos = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(wid)) as? [[String: Any]],
          let b = infos.first?[kCGWindowBounds as String] as? [String: Any],
          let ox = b["X"] as? Double, let oy = b["Y"] as? Double else { return nil }
    let scale = Double(NSScreen.main?.backingScaleFactor ?? 2.0)
    return CGPoint(x: ox + px / scale, y: oy + py / scale)
}
func cgClick(_ p: CGPoint, button: String) {
    let src = CGEventSource(stateID: .hidSystemState)
    let btn: CGMouseButton = button == "right" ? .right : .left
    let down: CGEventType = button == "right" ? .rightMouseDown : .leftMouseDown
    let up: CGEventType = button == "right" ? .rightMouseUp : .leftMouseUp
    CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: btn)?.post(tap: .cghidEventTap)
    CGEvent(mouseEventSource: src, mouseType: down, mouseCursorPosition: p, mouseButton: btn)?.post(tap: .cghidEventTap)
    CGEvent(mouseEventSource: src, mouseType: up, mouseCursorPosition: p, mouseButton: btn)?.post(tap: .cghidEventTap)
}
func cgType(_ text: String) {
    let src = CGEventSource(stateID: .hidSystemState)
    for ch in text {
        var u = Array(String(ch).utf16)
        if let d = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true) { d.keyboardSetUnicodeString(stringLength: u.count, unicodeString: &u); d.post(tap: .cghidEventTap) }
        if let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false) { up.keyboardSetUnicodeString(stringLength: u.count, unicodeString: &u); up.post(tap: .cghidEventTap) }
    }
}
let keyCodes: [String: CGKeyCode] = [
    // editing + navigation
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
    "forwarddelete": 117, "fwddelete": 117, "escape": 53, "esc": 53,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    // letters
    "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4, "i": 34, "j": 38,
    "k": 40, "l": 37, "m": 46, "n": 45, "o": 31, "p": 35, "q": 12, "r": 15, "s": 1, "t": 17,
    "u": 32, "v": 9, "w": 13, "x": 7, "y": 16, "z": 6,
    // digits
    "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25,
    // function keys
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
    "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    // punctuation
    "minus": 27, "equal": 24, "comma": 43, "period": 47, "slash": 44, "semicolon": 41,
    "quote": 39, "leftbracket": 33, "rightbracket": 30, "backslash": 42, "grave": 50
]
let modifierFlags: [String: CGEventFlags] = [
    "cmd": .maskCommand, "command": .maskCommand, "meta": .maskCommand, "super": .maskCommand,
    "shift": .maskShift, "alt": .maskAlternate, "option": .maskAlternate, "opt": .maskAlternate,
    "ctrl": .maskControl, "control": .maskControl, "fn": .maskSecondaryFn
]
// Accepts a single named key ("end", "v", "f5") OR a modifier combo ("cmd+End", "cmd+shift+v"):
// split on '+', the LAST token is the key, the rest fold into the event flags. Unknown key/modifier → false.
func cgKey(_ spec: String) -> Bool {
    var parts = spec.lowercased().split(separator: "+").map(String.init)
    guard let keyName = parts.popLast(), let code = keyCodes[keyName] else { return false }
    var flags: CGEventFlags = []
    for m in parts { guard let f = modifierFlags[m] else { return false }; flags.insert(f) }
    let src = CGEventSource(stateID: .hidSystemState)
    if let d = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true) { d.flags = flags; d.post(tap: .cghidEventTap) }
    if let u = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false) { u.flags = flags; u.post(tap: .cghidEventTap) }
    return true
}

// AXObserver: forward app-level change notifications so BlitzOS wakes the agent to refresh the widget.
var axObservers: [Int: AXObserver] = [:]
let axNotifs: [CFString] = [kAXValueChangedNotification as CFString, kAXTitleChangedNotification as CFString, kAXFocusedUIElementChangedNotification as CFString, kAXMainWindowChangedNotification as CFString]
let axCallback: AXObserverCallback = { _, _, notification, refcon in
    let pid = refcon != nil ? Int(bitPattern: refcon) : -1
    conn.send(["type": "event", "kind": "ax_changed", "pid": pid, "notification": notification as String])
}
func axObserve(pid: Int) -> Bool {
    if axObservers[pid] != nil { return true }
    var obs: AXObserver?
    guard AXObserverCreate(pid_t(pid), axCallback, &obs) == .success, let observer = obs else { return false }
    let app = axApp(pid)
    axEnableManual(app)
    let refcon = UnsafeMutableRawPointer(bitPattern: pid)
    for n in axNotifs { AXObserverAddNotification(observer, app, n, refcon) }
    CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode)
    axObservers[pid] = observer
    return true
}

// ===== Window picker: hover-highlight ANY macOS window + drag its app icon into a BlitzOS drop-zone =====
// BlitzOS arms this (`pick_start`) when the attach drop-zone is visible. We watch the cursor via a CGEventTap
// (Accessibility), hit-test the front window under it (CGWindowList, top-left global coords), and draw a glowing
// borderless overlay + the owner app's icon over it. Grabbing the icon starts a SELF-TRACKED drag (we own the whole
// gesture; nothing fragile crosses into Electron): a follow-the-cursor icon panel, and on release we test the cursor
// against the drop-zone rect BlitzOS gave us and emit `pick_drop {windowId,...}` (BlitzOS then connects that window).
// The overlays are non-activating + .accessory policy, so they never steal focus from the app you're aiming at.

func pickPrimaryHeight() -> CGFloat { NSScreen.screens.first?.frame.height ?? 0 }
// CG rect (top-left origin, what CGWindowList + CGEvent use) -> AppKit rect (bottom-left), flipped about the primary display.
func pickAppKitRect(fromCG cg: CGRect) -> NSRect {
    NSRect(x: cg.origin.x, y: pickPrimaryHeight() - cg.origin.y - cg.height, width: cg.width, height: cg.height)
}
func pickNum(_ a: Any?) -> CGFloat? {
    if let d = a as? Double { return CGFloat(d) }
    if let i = a as? Int { return CGFloat(i) }
    if let n = a as? NSNumber { return CGFloat(n.doubleValue) }
    return nil
}
func pickAppIcon(_ pid: Int) -> NSImage? { NSRunningApplication(processIdentifier: pid_t(pid))?.icon }

// The app icon as a 64x64 base64 PNG — sent with pick_drop so the dropbox can render the REAL macOS app icon.
func pickIconBase64(_ pid: Int) -> String {
    guard let img = NSRunningApplication(processIdentifier: pid_t(pid))?.icon else { return "" }
    let size = NSSize(width: 64, height: 64)
    let out = NSImage(size: size)
    out.lockFocus()
    img.draw(in: NSRect(origin: .zero, size: size), from: .zero, operation: .copy, fraction: 1.0)
    out.unlockFocus()
    guard let tiff = out.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
          let png = rep.representation(using: .png, properties: [:]) else { return "" }
    return png.base64EncodedString()
}

struct PickWin {
    let windowId: Int, pid: Int, app: String, bundleId: String, title: String
    let frameCG: CGRect // global, top-left origin
}

// A transparent, borderless, NON-activating, all-Spaces overlay we own. Purely visual: ignoresMouseEvents, so the
// CGEventTap (not the panel) handles every gesture, and the panel never eats clicks meant for the app underneath.
final class PickPanel: NSPanel {
    init(_ frame: NSRect, level: NSWindow.Level) {
        super.init(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        ignoresMouseEvents = true
        self.level = level
        collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        // .readOnly (the default) = the overlay IS captureable, so the hover-highlight glow + the
        // dragged app icon show up in the user's screen recording (Screen Studio / ScreenCaptureKit /
        // QuickTime). `.none` excludes a window from ALL screen capture by design, which used to hide
        // these picker overlays from the recorder too — fatal for filming the attach-drag demo. The
        // picker is a transient attach-gesture UI; the rare overlap with a computer-use window_screenshot
        // (which would now include the glow ring for the moment it is up) is acceptable.
        sharingType = .readOnly
    }
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

// The glow ring (a stroked rounded-rect with a colored shadow) over the window border + the app icon at its center.
final class PickHighlightView: NSView {
    private let ring = CAShapeLayer()
    private let iconHolder = NSView()
    private let iconView = NSImageView()
    let pad: CGFloat = 6 // the panel is inset OUT this much around the window, so the glow has room outside the border
    private let accent = NSColor(srgbRed: 0.39, green: 0.65, blue: 1.0, alpha: 1.0)

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.masksToBounds = false
        ring.fillColor = NSColor.clear.cgColor
        ring.strokeColor = accent.cgColor
        ring.lineWidth = 3
        ring.shadowColor = accent.cgColor
        ring.shadowRadius = 14
        ring.shadowOpacity = 0.95
        ring.shadowOffset = .zero
        ring.masksToBounds = false
        layer?.addSublayer(ring)
        iconHolder.wantsLayer = true
        iconHolder.layer?.backgroundColor = NSColor(white: 0.10, alpha: 0.92).cgColor
        iconHolder.layer?.cornerRadius = 13
        iconHolder.layer?.shadowColor = NSColor.black.cgColor
        iconHolder.layer?.shadowOpacity = 0.45
        iconHolder.layer?.shadowRadius = 9
        iconHolder.layer?.shadowOffset = CGSize(width: 0, height: -2)
        iconHolder.layer?.masksToBounds = false
        iconView.imageScaling = .scaleProportionallyUpOrDown
        iconHolder.addSubview(iconView)
        addSubview(iconHolder)
    }
    required init?(coder: NSCoder) { fatalError("no coder") }

    func setIcon(_ img: NSImage?) { iconView.image = img }
    // Hide just the centered app icon (the ring stays) — on grab, so only the dragged cursor icon is visible.
    func setIconHidden(_ hidden: Bool) { iconHolder.isHidden = hidden }

    override func layout() {
        super.layout()
        let r = bounds.insetBy(dx: pad, dy: pad) // the ring sits on the window's border
        ring.frame = bounds
        ring.path = CGPath(roundedRect: r, cornerWidth: 11, cornerHeight: 11, transform: nil)
        // icon centered on the window (its real middle), so it reads as "this whole window".
        let box: CGFloat = 56, icon: CGFloat = 44
        iconHolder.frame = CGRect(x: bounds.midX - box / 2, y: bounds.midY - box / 2, width: box, height: box)
        iconView.frame = CGRect(x: (box - icon) / 2, y: (box - icon) / 2, width: icon, height: icon)
    }
}

// The small icon that follows the cursor during a drag.
final class PickDragView: NSView {
    private let iconView = NSImageView()
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        iconView.imageScaling = .scaleProportionallyUpOrDown
        iconView.wantsLayer = true
        iconView.layer?.shadowColor = NSColor.black.cgColor
        iconView.layer?.shadowOpacity = 0.5
        iconView.layer?.shadowRadius = 8
        iconView.layer?.shadowOffset = CGSize(width: 0, height: -2)
        iconView.layer?.masksToBounds = false
        addSubview(iconView)
    }
    required init?(coder: NSCoder) { fatalError("no coder") }
    override func layout() { super.layout(); iconView.frame = bounds.insetBy(dx: 5, dy: 5) }
    func setIcon(_ img: NSImage?) { iconView.image = img }
}

var pickController: PickController?

// The C event-tap callback can't capture Swift context, so it routes through the userInfo pointer to the controller.
let pickTapCallback: CGEventTapCallBack = { _, type, event, refcon in
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let rc = refcon { Unmanaged<PickController>.fromOpaque(rc).takeUnretainedValue().reenable() }
        return Unmanaged.passUnretained(event)
    }
    guard let rc = refcon else { return Unmanaged.passUnretained(event) }
    return Unmanaged<PickController>.fromOpaque(rc).takeUnretainedValue().handle(type: type, event: event)
}

final class PickController {
    private var tap: CFMachPort?
    private var src: CFRunLoopSource?
    private var dropZone = CGRect.zero // global, top-left — releasing a drag here = drop
    private var selfRect = CGRect.zero // the BlitzOS island chassis: cursor over it = its OWN UI (don't look through it)
    private var excludePids = Set<Int>()
    private let ownPid = Int(ProcessInfo.processInfo.processIdentifier)

    private var highlightPanel: PickPanel?
    private var highlightView: PickHighlightView?
    private var dragPanel: PickPanel?
    private var dragView: PickDragView?

    private var hovered: PickWin?
    private var dragging = false
    private var dragWin: PickWin?
    private var lastHoverWid = -1
    private var lastInside = false

    // Arm (or re-arm) the picker. Re-callable to just update the rects (the tap is created once).
    func start(dropZone: CGRect, selfRect: CGRect, excludePids: [Int]) -> Bool {
        self.dropZone = dropZone
        self.selfRect = selfRect
        self.excludePids = Set(excludePids)
        if tap == nil {
            var m: CGEventMask = 0
            for t: CGEventType in [.mouseMoved, .leftMouseDown, .leftMouseDragged, .leftMouseUp] {
                m |= (CGEventMask(1) << CGEventMask(t.rawValue))
            }
            guard let t = CGEvent.tapCreate(tap: .cghidEventTap, place: .headInsertEventTap, options: .defaultTap,
                                            eventsOfInterest: m, callback: pickTapCallback,
                                            userInfo: Unmanaged.passUnretained(self).toOpaque()) else { return false }
            let s = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, t, 0)
            CFRunLoopAddSource(CFRunLoopGetMain(), s, .commonModes)
            CGEvent.tapEnable(tap: t, enable: true)
            tap = t; src = s
        }
        return true
    }

    func updateDropZone(_ z: CGRect) { dropZone = z }
    func reenable() { if let t = tap { CGEvent.tapEnable(tap: t, enable: true) } }

    func stop() {
        if let t = tap { CGEvent.tapEnable(tap: t, enable: false) }
        if let s = src { CFRunLoopRemoveSource(CFRunLoopGetMain(), s, .commonModes) }
        tap = nil; src = nil
        teardownDrag()
        highlightPanel?.orderOut(nil); highlightPanel = nil; highlightView = nil
        hovered = nil; lastHoverWid = -1; dragging = false; dragWin = nil; lastInside = false
    }

    // The tap callback (on the main run loop). Returning nil SWALLOWS the event; passUnretained passes it on.
    func handle(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        let p = event.location // global, top-left
        switch type {
        case .mouseMoved:
            if !dragging { updateHover(p) }
        case .leftMouseDown:
            // mousedown ANYWHERE on a highlighted window grabs it (the whole window is the handle) — the icon snaps
            // to the cursor. Swallow ONLY this grab click so the OS never starts a window-drag / shifts focus. If the
            // cursor is NOT over a grabbable window (Dock, menu bar, desktop, the island) `hovered` is nil, so we pass
            // the click through and normal macOS interactions keep working.
            if !dragging, let h = hovered {
                beginDrag(h, at: p)
                return nil
            }
        case .leftMouseDragged:
            if dragging { moveDrag(p) }
        case .leftMouseUp:
            if dragging { endDrag(p) }
        default: break
        }
        return Unmanaged.passUnretained(event)
    }

    // The frontmost NORMAL app window (layer 0) under the cursor, skipping BlitzOS + our own overlays. We filter to
    // layer 0 so the Dock / menu bar / desktop (higher- or lower-layer system windows, several of them FULL-SCREEN —
    // e.g. the Dock keeps a 1512x982 backing window at layer 20) never count: those strips have no layer-0 window, so
    // the cursor over them returns nil → no glow/grab and the click passes straight through (Dock + menu bar stay
    // clickable while picking). mousedown anywhere INSIDE a returned window grabs the whole thing.
    private func frontWindowAt(_ p: CGPoint) -> PickWin? {
        // Over the BlitzOS island chrome (the chassis: X button, msg bar, dropbox, tabs) → don't look THROUGH the
        // transparent island to the window behind it. The island is always "on top", so its own UI wins the click.
        if selfRect.contains(p) { return nil }
        let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let infos = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { return nil }
        for info in infos { // front-to-back order
            if (info[kCGWindowLayer as String] as? Int) ?? 0 != 0 { continue } // normal app windows only
            let pid = (info[kCGWindowOwnerPID as String] as? Int) ?? 0
            if pid == ownPid || excludePids.contains(pid) { continue } // our overlays + BlitzOS's island window
            guard let b = info[kCGWindowBounds as String] as? [String: Any],
                  let x = pickNum(b["X"]), let y = pickNum(b["Y"]),
                  let w = pickNum(b["Width"]), let hh = pickNum(b["Height"]),
                  w > 40, hh > 40 else { continue }
            let rect = CGRect(x: x, y: y, width: w, height: hh)
            if rect.contains(p) {
                let app = (info[kCGWindowOwnerName as String] as? String) ?? ""
                return PickWin(windowId: (info[kCGWindowNumber as String] as? Int) ?? 0, pid: pid, app: app,
                               bundleId: NSRunningApplication(processIdentifier: pid_t(pid))?.bundleIdentifier ?? "",
                               title: (info[kCGWindowName as String] as? String) ?? "", frameCG: rect)
            }
        }
        return nil
    }

    private func updateHover(_ p: CGPoint) {
        let hit = frontWindowAt(p)
        hovered = hit
        let wid = hit?.windowId ?? -1
        if wid == lastHoverWid { return }
        lastHoverWid = wid
        if let h = hit { showHighlight(h); emit(["kind": "pick_hover", "windowId": h.windowId, "pid": h.pid, "app": h.app, "bundleId": h.bundleId, "title": h.title]) }
        else { highlightPanel?.orderOut(nil) }
    }

    private func showHighlight(_ h: PickWin) {
        let ns = pickAppKitRect(fromCG: h.frameCG.insetBy(dx: -6, dy: -6))
        if highlightPanel == nil {
            let v = PickHighlightView(frame: NSRect(origin: .zero, size: ns.size))
            let panel = PickPanel(NSRect(origin: .zero, size: ns.size), level: .floating)
            panel.contentView = v
            highlightPanel = panel; highlightView = v
        }
        highlightView?.setIcon(pickAppIcon(h.pid))
        highlightView?.setIconHidden(false) // a fresh hover always shows the centered icon (it's hidden during a drag)
        highlightPanel?.setFrame(ns, display: true)
        highlightView?.needsLayout = true
        highlightPanel?.orderFront(nil)
    }

    private func beginDrag(_ h: PickWin, at p: CGPoint) {
        dragging = true; dragWin = h; lastInside = false
        highlightView?.setIconHidden(true) // on grab, hide the static center icon so only the cursor icon is visible
        let v = PickDragView(frame: NSRect(x: 0, y: 0, width: 54, height: 54))
        v.setIcon(pickAppIcon(h.pid))
        // ABOVE the BlitzOS island (which sits at .screenSaver) so the dragged icon stays visible as it travels
        // into the drop-zone on the island, instead of vanishing behind it.
        let panel = PickPanel(NSRect(x: 0, y: 0, width: 54, height: 54), level: NSWindow.Level(rawValue: NSWindow.Level.screenSaver.rawValue + 1))
        panel.contentView = v
        dragPanel = panel; dragView = v
        centerDrag(p)
        panel.orderFront(nil)
    }

    private func centerDrag(_ p: CGPoint) {
        guard let panel = dragPanel else { return }
        let y = pickPrimaryHeight() - p.y // top-left → bottom-left
        panel.setFrameOrigin(NSPoint(x: p.x - panel.frame.width / 2, y: y - panel.frame.height / 2))
    }

    private func moveDrag(_ p: CGPoint) {
        centerDrag(p)
        let inside = dropZone.contains(p)
        if inside != lastInside { lastInside = inside; emit(["kind": "pick_over", "inside": inside]) }
    }

    private func endDrag(_ p: CGPoint) {
        let inside = dropZone.contains(p)
        let h = dragWin
        teardownDrag()
        if inside, let h = h {
            // bounds (CG global, top-left points) ride along so BlitzOS can match this window to the Chrome
            // extension's window list (the bridge from a CGWindow to a precise browser tab).
            emit(["kind": "pick_drop", "windowId": h.windowId, "pid": h.pid, "app": h.app, "bundleId": h.bundleId, "title": h.title, "icon": pickIconBase64(h.pid),
                  "x": Double(h.frameCG.origin.x), "y": Double(h.frameCG.origin.y), "w": Double(h.frameCG.width), "h": Double(h.frameCG.height)])
        } else {
            emit(["kind": "pick_cancel"])
        }
        lastHoverWid = -1 // force a fresh hover hit-test on the next move
    }

    private func teardownDrag() {
        dragging = false; dragWin = nil; lastInside = false
        dragPanel?.orderOut(nil); dragPanel = nil; dragView = nil
    }

    private func emit(_ obj: [String: Any]) {
        var o = obj; o["type"] = "event"; conn.send(o)
    }
}

// ---- the connection to BlitzOS (a Unix domain socket BlitzOS owns; we connect on launch) ----
final class HelperConnection {
    private let fd: Int32
    private var inBuffer = Data()
    private let queue = DispatchQueue(label: "dev.blitz.os.computeruse.io")

    init?(socketPath: String) {
        fd = socket(AF_UNIX, SOCK_STREAM, 0)
        if fd < 0 { return nil }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = socketPath.utf8CString
        if pathBytes.count > MemoryLayout.size(ofValue: addr.sun_path) { return nil }
        withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
            ptr.withMemoryRebound(to: CChar.self, capacity: pathBytes.count) { dst in
                for (i, b) in pathBytes.enumerated() { dst[i] = b }
            }
        }
        let len = socklen_t(MemoryLayout<sockaddr_un>.size)
        let ok = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, len) }
        }
        if ok != 0 { close(fd); return nil }
    }

    func send(_ obj: [String: Any]) {
        let data = jsonLine(obj)
        data.withUnsafeBytes { raw in
            var off = 0
            let base = raw.bindMemory(to: UInt8.self).baseAddress!
            while off < data.count {
                let n = write(fd, base + off, data.count - off)
                if n <= 0 { break }
                off += n
            }
        }
    }

    // Blocking read loop on a background queue; dispatches each complete JSON line to `handle`.
    func run(handle: @escaping ([String: Any]) -> Void) {
        queue.async {
            var chunk = [UInt8](repeating: 0, count: 8192)
            while true {
                let n = read(self.fd, &chunk, chunk.count)
                if n <= 0 { break } // BlitzOS closed the socket → exit
                self.inBuffer.append(contentsOf: chunk[0..<n])
                while let nl = self.inBuffer.firstIndex(of: 0x0A) {
                    let lineData = self.inBuffer.subdata(in: self.inBuffer.startIndex..<nl)
                    self.inBuffer.removeSubrange(self.inBuffer.startIndex...nl)
                    if let obj = (try? JSONSerialization.jsonObject(with: lineData)) as? [String: Any] {
                        handle(obj)
                    }
                }
            }
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }
}

// ---- main ----------------------------------------------------------------------------------
func socketPathArg() -> String? {
    let args = CommandLine.arguments
    if let i = args.firstIndex(of: "--connect"), i + 1 < args.count { return args[i + 1] }
    return nil
}

let bundleId = Bundle.main.bundleIdentifier ?? "dev.blitz.os.computeruse"
guard let socketPath = socketPathArg(), let liveConn = HelperConnection(socketPath: socketPath) else {
    FileHandle.standardError.write(Data("BlitzOS helper: missing/failed --connect <socket>\n".utf8))
    exit(2)
}
conn = liveConn

// A faceless agent: no dock icon, no menus (Info.plist LSUIElement also set).
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

conn.send(["type": "hello", "bundleId": bundleId, "pid": ProcessInfo.processInfo.processIdentifier, "tcc": tccStatus()])

conn.run { msg in
    let id = msg["id"] as? Int ?? -1
    let cmd = msg["cmd"] as? String ?? ""
    func reply(_ payload: [String: Any]) {
        var out = payload
        out["type"] = "reply"
        out["id"] = id
        conn.send(out)
    }
    DispatchQueue.main.async {
        switch cmd {
        case "tcc_status": reply(["tcc": tccStatus()])
        case "request_accessibility": requestAccessibility(); reply(["tcc": tccStatus()])
        case "request_screen": requestScreen(); reply(["tcc": tccStatus()])
        case "screenshot":
            if let b64 = screenshotBase64() { reply(["ok": true, "png": b64]) } else { reply(["ok": false, "error": "capture failed (Screen Recording not granted?)"]) }
        case "scan":
            // Run the onboarding scan under the helper (→ helper's FDA). Reply comes async on exit.
            let node = msg["node"] as? String ?? ""
            let script = msg["script"] as? String ?? ""
            let sargs = msg["args"] as? [String] ?? []
            let senv = msg["env"] as? [String: String] ?? [:]
            if node.isEmpty || script.isEmpty { reply(["ok": false, "error": "scan: node+script required"]) } else { runScan(conn, id: id, node: node, script: script, args: sargs, env: senv) }
        case "osa":
            // Run osascript under the helper + RETURN its stdout (the browser connection links route through this
            // so the Automation grant stays on the helper). Reply comes async on exit.
            runOsa(conn, id: id, args: msg["args"] as? [String] ?? [])
        case "list_windows": reply(["ok": true, "windows": listWindows()])
        case "ax_tree", "ax_read":
            let pid = msg["pid"] as? Int ?? -1
            if pid < 0 { reply(["error": "pid required"]) } else { reply(["ok": true, "tree": axTree(pid: pid, maxDepth: msg["maxDepth"] as? Int ?? 12, limit: msg["limit"] as? Int ?? 600)]) }
        case "ax_act":
            let pid = msg["pid"] as? Int ?? -1
            if pid < 0 { reply(["error": "pid required"]) } else { reply(axAct(pid: pid, find: msg["find"] as? [String: Any] ?? [:], action: msg["action"] as? String ?? "press", value: msg["value"] as? String)) }
        case "window_screenshot":
            let wid = msg["windowId"] as? Int ?? -1
            if wid < 0 { reply(["error": "windowId required"]) }
            else if #available(macOS 14.0, *) { windowShot(windowId: wid, reply: reply) }
            else { reply(["error": "window screenshot needs macOS 14+"]) }
        case "cg_click":
            if let p = cgPoint(windowId: msg["windowId"] as? Int, px: msg["px"] as? Double, py: msg["py"] as? Double, x: msg["x"] as? Double, y: msg["y"] as? Double) {
                cgClick(p, button: msg["button"] as? String ?? "left"); reply(["ok": true, "effect": ["clicked": ["x": p.x, "y": p.y]]])
            } else { reply(["error": "cg_click needs {x,y} or {windowId,px,py}"]) }
        case "cg_type": cgType(msg["text"] as? String ?? ""); reply(["ok": true, "effect": ["typed": msg["text"] as? String ?? ""]])
        case "cg_key": reply(cgKey(msg["key"] as? String ?? "") ? ["ok": true, "effect": ["key": msg["key"] as? String ?? ""]] : ["error": "unknown key name"])
        case "activate":
            // Bring the app (and its windows) to the front — connection_reveal for a window. CGEvent input lands
            // on the FOCUSED app, so the agent reveals the target window before key/type/paste.
            let apid = msg["pid"] as? Int ?? -1
            if apid > 0, let app = NSRunningApplication(processIdentifier: pid_t(apid)) {
                app.activate(options: [.activateAllWindows]); reply(["ok": true, "effect": ["activated": apid]])
            } else { reply(["error": "activate needs a valid pid"]) }
        case "ax_observe":
            let pid = msg["pid"] as? Int ?? -1
            if pid < 0 { reply(["error": "pid required"]) } else { reply(["ok": axObserve(pid: pid)]) }
        case "pick_start":
            // Arm the window picker. dropZone {x,y,w,h} in global top-left points; excludePids skips BlitzOS's own window.
            if pickController == nil { pickController = PickController() }
            let dz = msg["dropZone"] as? [String: Any] ?? [:]
            let rect = CGRect(x: pickNum(dz["x"]) ?? 0, y: pickNum(dz["y"]) ?? 0, width: pickNum(dz["w"]) ?? 0, height: pickNum(dz["h"]) ?? 0)
            let sr = msg["selfRect"] as? [String: Any] ?? [:]
            let selfR = CGRect(x: pickNum(sr["x"]) ?? 0, y: pickNum(sr["y"]) ?? 0, width: pickNum(sr["w"]) ?? 0, height: pickNum(sr["h"]) ?? 0)
            let ok = pickController!.start(dropZone: rect, selfRect: selfR, excludePids: (msg["excludePids"] as? [Int]) ?? [])
            reply(ok ? ["ok": true] : ["ok": false, "error": "could not create event tap (is Accessibility granted to BlitzOS?)"])
        case "pick_update":
            let dz = msg["dropZone"] as? [String: Any] ?? [:]
            pickController?.updateDropZone(CGRect(x: pickNum(dz["x"]) ?? 0, y: pickNum(dz["y"]) ?? 0, width: pickNum(dz["w"]) ?? 0, height: pickNum(dz["h"]) ?? 0))
            reply(["ok": true])
        case "pick_stop": pickController?.stop(); reply(["ok": true])
        case "ping": reply(["pong": true])
        case "quit": reply(["ok": true]); NSApp.terminate(nil)
        default: reply(["ok": false, "error": "unknown cmd: \(cmd)"])
        }
    }
}

app.run()
