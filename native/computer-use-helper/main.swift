// BlitzComputerUse — the separate, Developer-ID-signed background helper that HOLDS the
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
    for info in infos {
        if (info[kCGWindowLayer as String] as? Int) ?? 0 != 0 { continue } // normal app windows only
        let wid = (info[kCGWindowNumber as String] as? Int) ?? 0
        let pid = (info[kCGWindowOwnerPID as String] as? Int) ?? 0
        let app = (info[kCGWindowOwnerName as String] as? String) ?? ""
        let title = (info[kCGWindowName as String] as? String) ?? ""
        let bounds = (info[kCGWindowBounds as String] as? [String: Any]) ?? [:]
        let bundleId = NSRunningApplication(processIdentifier: pid_t(pid))?.bundleIdentifier ?? ""
        out.append(["windowId": wid, "pid": pid, "app": app, "bundleId": bundleId, "title": title, "bounds": bounds])
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
let keyCodes: [String: CGKeyCode] = ["return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "escape": 53, "esc": 53, "left": 123, "right": 124, "down": 125, "up": 126]
func cgKey(_ name: String) -> Bool {
    guard let code = keyCodes[name.lowercased()] else { return false }
    let src = CGEventSource(stateID: .hidSystemState)
    CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true)?.post(tap: .cghidEventTap)
    CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false)?.post(tap: .cghidEventTap)
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
    FileHandle.standardError.write(Data("BlitzComputerUse: missing/failed --connect <socket>\n".utf8))
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
        case "ax_observe":
            let pid = msg["pid"] as? Int ?? -1
            if pid < 0 { reply(["error": "pid required"]) } else { reply(["ok": axObserve(pid: pid)]) }
        case "ping": reply(["pong": true])
        case "quit": reply(["ok": true]); NSApp.terminate(nil)
        default: reply(["ok": false, "error": "unknown cmd: \(cmd)"])
        }
    }
}

app.run()
