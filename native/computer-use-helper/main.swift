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
guard let socketPath = socketPathArg(), let conn = HelperConnection(socketPath: socketPath) else {
    FileHandle.standardError.write(Data("BlitzComputerUse: missing/failed --connect <socket>\n".utf8))
    exit(2)
}

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
        case "ping": reply(["pong": true])
        case "quit": reply(["ok": true]); NSApp.terminate(nil)
        default: reply(["ok": false, "error": "unknown cmd: \(cmd)"])
        }
    }
}

app.run()
