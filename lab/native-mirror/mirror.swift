// BlitzOS lab — native-mirror spike (lab/native-mirror).
//
// Prove "full live use" of an arbitrary native macOS app streamed into a surface we control:
//   - capture EVERY window of a target app (multi-window) via ScreenCaptureKit, zero-copy IOSurface
//   - display each window in our own borderless window (a live mirror)
//   - forward mouse / scroll / keyboard back to the real app via CGEventPostToPid
//
// Standalone on purpose. The BlitzOS integration (IOSurface into the L0 `pages` window + a
// `nativeapp` surface kind) is phase 2 — see README.md. Coordinate spaces are the trap here:
// SCWindow.frame and CGEvent positions are CG global (TOP-LEFT origin); NSWindow.frame is AppKit
// (BOTTOM-LEFT origin). We keep input math in CG and only flip when placing our NSWindow.

import Foundation
import AppKit
import ScreenCaptureKit
import CoreMedia
import CoreVideo
import CoreGraphics
import QuartzCore
import IOSurface
import ApplicationServices

// MARK: - config -----------------------------------------------------------------------------

struct Config {
    var bundleId: String?
    var appName: String?
    var fps: Int32 = 60
    var offset = CGSize(width: 0, height: 0) // mirror sits ON the source (recursion is excluded via sharingType); pass --offset to separate them
    var debug = false
}

func parseArgs() -> Config {
    var c = Config()
    var it = CommandLine.arguments.dropFirst().makeIterator()
    while let a = it.next() {
        switch a {
        case "--app": c.bundleId = it.next()
        case "--name": c.appName = it.next()
        case "--fps": if let v = it.next(), let n = Int32(v) { c.fps = n }
        case "--offset":
            if let xs = it.next(), let ys = it.next(), let x = Double(xs), let y = Double(ys) {
                c.offset = CGSize(width: x, height: y)
            }
        case "--debug": c.debug = true
        default: break
        }
    }
    return c
}

func logErr(_ s: String) { FileHandle.standardError.write(Data((s + "\n").utf8)) }

// MARK: - geometry ---------------------------------------------------------------------------

func primaryHeight() -> CGFloat { NSScreen.screens.first?.frame.height ?? 0 }

/// CG rect (top-left origin) -> AppKit rect (bottom-left origin), flipped about the primary display.
func appKitRect(fromCG cg: CGRect) -> NSRect {
    NSRect(x: cg.origin.x, y: primaryHeight() - cg.origin.y - cg.height, width: cg.width, height: cg.height)
}

// MARK: - input synthesis --------------------------------------------------------------------
// CGEventPostToPid delivers straight to the target process (no on-screen hit-test), which is what we
// want for an offset/hidden source. It SILENTLY no-ops unless the posting process has Accessibility.

let evSource = CGEventSource(stateID: .hidSystemState)
var DEBUG = false
func dlog(_ s: String) { if DEBUG { logErr(s) } }

func cgFlags(_ m: NSEvent.ModifierFlags) -> CGEventFlags {
    var f = CGEventFlags()
    if m.contains(.shift) { f.insert(.maskShift) }
    if m.contains(.control) { f.insert(.maskControl) }
    if m.contains(.option) { f.insert(.maskAlternate) }
    if m.contains(.command) { f.insert(.maskCommand) }
    if m.contains(.function) { f.insert(.maskSecondaryFn) }
    return f
}

func postMouse(_ type: CGEventType, at p: CGPoint, button: CGMouseButton, pid: pid_t, flags: CGEventFlags) {
    guard let e = CGEvent(mouseEventSource: evSource, mouseType: type, mouseCursorPosition: p, mouseButton: button) else { return }
    e.flags = flags
    e.postToPid(pid)
}

func postScroll(dx: Int32, dy: Int32, pid: pid_t) {
    guard let e = CGEvent(scrollWheelEvent2Source: evSource, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) else { return }
    e.postToPid(pid)
}

func postKey(_ keyCode: CGKeyCode, down: Bool, flags: CGEventFlags, pid: pid_t) {
    guard let e = CGEvent(keyboardEventSource: evSource, virtualKey: keyCode, keyDown: down) else { return }
    e.flags = flags
    e.postToPid(pid)
}

// MARK: - mirror window + view ---------------------------------------------------------------

/// Borderless windows refuse key/main by default; we need both to receive keyboard + clicks.
final class MirrorWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
    // Route keystrokes to the MirrorView: a borderless window has no default first responder, so
    // keyDown never fired without this (the keyboard half of "couldn't do anything").
    override func becomeKey() {
        super.becomeKey()
        if let v = contentView { makeFirstResponder(v) }
    }
}

/// Displays one source window's IOSurface and forwards input to the owning app's pid.
final class MirrorView: NSView {
    let pid: pid_t
    var sourceCG: CGRect            // live source frame in CG coords (top-left), updated by the controller
    private let contentLayer = CALayer()

    init(pid: pid_t, sourceCG: CGRect) {
        self.pid = pid
        self.sourceCG = sourceCG
        super.init(frame: NSRect(origin: .zero, size: sourceCG.size))
        wantsLayer = true
        layer?.backgroundColor = NSColor.black.cgColor
        layer?.borderColor = NSColor.systemGreen.cgColor
        layer?.borderWidth = 1.5            // so you can tell the mirror from the real window
        contentLayer.contentsGravity = .resize
        contentLayer.frame = bounds
        layer?.addSublayer(contentLayer)
    }
    required init?(coder: NSCoder) { fatalError("no coder") }

    override func layout() {
        super.layout()
        contentLayer.frame = bounds
        contentLayer.contentsScale = window?.backingScaleFactor ?? 2
    }

    func present(_ surface: IOSurfaceRef) { contentLayer.contents = surface }

    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    /// view-local AppKit point (bottom-left) -> CG global point inside the source window (top-left).
    private func cgPoint(_ ev: NSEvent) -> CGPoint {
        let local = convert(ev.locationInWindow, from: nil)
        let topLeftY = bounds.height - local.y
        return CGPoint(x: sourceCG.origin.x + local.x, y: sourceCG.origin.y + topLeftY)
    }

    override func mouseDown(with e: NSEvent)         { let p = cgPoint(e); dlog("mouseDown \(Int(p.x)),\(Int(p.y)) -> pid \(pid)"); postMouse(.leftMouseDown, at: p, button: .left, pid: pid, flags: cgFlags(e.modifierFlags)) }
    override func mouseUp(with e: NSEvent)           { postMouse(.leftMouseUp, at: cgPoint(e), button: .left, pid: pid, flags: cgFlags(e.modifierFlags)) }
    override func mouseDragged(with e: NSEvent)      { postMouse(.leftMouseDragged, at: cgPoint(e), button: .left, pid: pid, flags: cgFlags(e.modifierFlags)) }
    override func rightMouseDown(with e: NSEvent)    { postMouse(.rightMouseDown, at: cgPoint(e), button: .right, pid: pid, flags: cgFlags(e.modifierFlags)) }
    override func rightMouseUp(with e: NSEvent)      { postMouse(.rightMouseUp, at: cgPoint(e), button: .right, pid: pid, flags: cgFlags(e.modifierFlags)) }
    override func rightMouseDragged(with e: NSEvent) { postMouse(.rightMouseDragged, at: cgPoint(e), button: .right, pid: pid, flags: cgFlags(e.modifierFlags)) }
    override func mouseMoved(with e: NSEvent)        { postMouse(.mouseMoved, at: cgPoint(e), button: .left, pid: pid, flags: cgFlags(e.modifierFlags)) }
    override func scrollWheel(with e: NSEvent)       { postScroll(dx: Int32(e.scrollingDeltaX), dy: Int32(e.scrollingDeltaY), pid: pid) }
    override func keyDown(with e: NSEvent)           { dlog("keyDown code \(e.keyCode) -> pid \(pid)"); postKey(CGKeyCode(e.keyCode), down: true, flags: cgFlags(e.modifierFlags), pid: pid) }
    override func keyUp(with e: NSEvent)             { postKey(CGKeyCode(e.keyCode), down: false, flags: cgFlags(e.modifierFlags), pid: pid) }
}

// MARK: - one captured window ----------------------------------------------------------------

final class WindowMirror: NSObject, SCStreamOutput, SCStreamDelegate {
    let windowID: CGWindowID
    let pid: pid_t
    let win: MirrorWindow
    let view: MirrorView
    private var stream: SCStream?
    private let outQueue = DispatchQueue(label: "blitz.lab.mirror.out")
    private var lastSize: CGSize
    private let fps: Int32

    init(scWindow: SCWindow, pid: pid_t, offset: CGSize, fps: Int32) {
        self.windowID = scWindow.windowID
        self.pid = pid
        self.fps = fps
        let cg = scWindow.frame
        self.lastSize = cg.size
        self.view = MirrorView(pid: pid, sourceCG: cg)
        let nsRect = appKitRect(fromCG: cg).offsetBy(dx: offset.width, dy: -offset.height)
        self.win = MirrorWindow(contentRect: nsRect, styleMask: [.borderless], backing: .buffered, defer: false)
        super.init()
        win.contentView = view
        win.isOpaque = false
        win.backgroundColor = .clear
        // EXCLUDE the mirror from screen capture, or it captures itself: the mirror overlaps the
        // source window on screen, the source's capture then includes the mirror's pixels, and you
        // get an infinite window-in-window feedback loop (camera pointed at its own monitor).
        // sharingType .none keeps the window out of ALL captures (incl. our own SCStream) while it
        // still displays normally to the user.
        win.sharingType = .none
        win.level = .floating
        win.acceptsMouseMovedEvents = true
        win.hasShadow = true
        win.orderFront(nil)
        startCapture(scWindow: scWindow)
    }

    private func makeConfig(_ size: CGSize) -> SCStreamConfiguration {
        let scale = NSScreen.main?.backingScaleFactor ?? 2
        let cfg = SCStreamConfiguration()
        cfg.width = max(2, Int(size.width * scale))
        cfg.height = max(2, Int(size.height * scale))
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        cfg.queueDepth = 5
        cfg.showsCursor = true
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        return cfg
    }

    private func startCapture(scWindow: SCWindow) {
        let filter = SCContentFilter(desktopIndependentWindow: scWindow)
        let s = SCStream(filter: filter, configuration: makeConfig(scWindow.frame.size), delegate: self)
        do {
            try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: outQueue)
            s.startCapture { err in if let err = err { logErr("startCapture: \(err.localizedDescription)") } }
            self.stream = s
        } catch {
            logErr("addStreamOutput: \(error.localizedDescription)")
        }
    }

    /// Keep the mirror glued to the source: reposition, and resize the stream when the window resizes.
    func update(scWindow: SCWindow, offset: CGSize) {
        let cg = scWindow.frame
        view.sourceCG = cg
        win.setFrame(appKitRect(fromCG: cg).offsetBy(dx: offset.width, dy: -offset.height), display: true)
        if cg.size != lastSize {
            lastSize = cg.size
            stream?.updateConfiguration(makeConfig(cg.size)) { err in if let err = err { logErr("updateConfiguration: \(err.localizedDescription)") } }
        }
    }

    func stop() {
        stream?.stopCapture { _ in }
        win.orderOut(nil)
    }

    // SCStreamOutput — frames arrive on outQueue; assign on main, keeping the buffer alive across the hop.
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen else { return }
        guard let arr = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let attach = arr.first,
              let raw = attach[.status] as? Int,
              let status = SCFrameStatus(rawValue: raw),
              status == .complete,
              let pb = CMSampleBufferGetImageBuffer(sampleBuffer),
              let surface = CVPixelBufferGetIOSurface(pb)?.takeUnretainedValue()
        else { return }
        let keepAlive = pb // retains the pixel buffer (and its IOSurface) until the closure runs
        DispatchQueue.main.async { [weak self] in
            self?.view.present(surface)
            _ = keepAlive
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        logErr("stream stopped: \(error.localizedDescription)")
    }
}

// MARK: - controller: discover the app's windows + keep mirrors in sync -----------------------

final class MirrorController {
    private let config: Config
    private var pid: pid_t = 0
    private var mirrors: [CGWindowID: WindowMirror] = [:]
    private var timer: Timer?

    init(config: Config) { self.config = config }

    func start() {
        refresh(initial: true)
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in self?.refresh(initial: false) }
    }

    private func refresh(initial: Bool) {
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { [weak self] content, error in
            guard let self = self else { return }
            guard let content = content else {
                if let error = error { logErr("SCShareableContent: \(error.localizedDescription)") }
                return
            }
            let ownBundle = Bundle.main.bundleIdentifier
            let target = content.applications.first { app in
                if app.bundleIdentifier == ownBundle { return false } // never mirror ourselves (recursion)
                if let b = self.config.bundleId { return app.bundleIdentifier == b }
                if let n = self.config.appName { return app.applicationName.lowercased().contains(n.lowercased()) }
                return false
            }
            guard let target = target else {
                if initial { logErr("target app not found / not running (start it first)") }
                return
            }
            let appWins = content.windows.filter { $0.owningApplication?.processID == target.processID }
            if initial {
                for w in appWins {
                    logErr("[win] id=\(w.windowID) onScreen=\(w.isOnScreen) layer=\(w.windowLayer) \(Int(w.frame.width))x\(Int(w.frame.height)) '\(w.title ?? "")'")
                }
            }
            // isOnScreen drops the black phantom (a background/occluded window SCK still lists); the
            // size floor drops tiny helper windows. Real popups/menus are on-screen, so they survive.
            let wins = appWins.filter { $0.isOnScreen && $0.frame.width > 40 && $0.frame.height > 40 }
            let pid = target.processID
            DispatchQueue.main.async { self.reconcile(wins, pid: pid, initial: initial) }
        }
    }

    private func reconcile(_ wins: [SCWindow], pid: pid_t, initial: Bool) {
        self.pid = pid
        let live = Set(wins.map { $0.windowID })
        for (id, m) in mirrors where !live.contains(id) {
            m.stop()
            mirrors[id] = nil
        }
        for w in wins {
            if let m = mirrors[w.windowID] {
                m.update(scWindow: w, offset: config.offset)
            } else {
                mirrors[w.windowID] = WindowMirror(scWindow: w, pid: pid, offset: config.offset, fps: config.fps)
                logErr("mirroring window \(w.windowID) \(Int(w.frame.width))x\(Int(w.frame.height)) title=\(w.title ?? "")")
            }
        }
        if initial && mirrors.isEmpty { logErr("app is running but no windows matched (try --offset to see them, or check it has visible windows)") }
        // Do NOT steal focus from the host (BlitzOS) on every reconcile tick. ignoringOtherApps:true
        // yanked the key window to the mirror each frame, which read as a BlitzOS "freeze" (the host
        // sits maximized underneath, so the cover-up is total). `false` re-activates only when the
        // mirror is ALREADY frontmost — a no-op while you work in BlitzOS — so the mirror stays put
        // when you're using it but never rips focus from the host. (Launch-time activate stays below.)
        if !mirrors.isEmpty { NSApp.activate(ignoringOtherApps: false) }
    }
}

// MARK: - app entry --------------------------------------------------------------------------

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let config: Config
    private var controller: MirrorController?
    init(config: Config) { self.config = config }
    func applicationDidFinishLaunching(_ note: Notification) {
        let c = MirrorController(config: config)
        c.start()
        controller = c
        NSApp.activate(ignoringOtherApps: true)
    }
}

let cfg = parseArgs()
if cfg.bundleId == nil && cfg.appName == nil {
    logErr("usage: native-mirror --app <bundle-id> | --name <app-name> [--offset dx dy] [--fps n]")
    exit(2)
}

DEBUG = cfg.debug

// TCC: capture needs Screen Recording, input needs Accessibility. Prompt for both up front.
if !CGPreflightScreenCaptureAccess() { CGRequestScreenCaptureAccess() }
_ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as NSString: true] as CFDictionary)
let axOK = AXIsProcessTrusted()
logErr("[mirror] Screen Recording: \(CGPreflightScreenCaptureAccess())   Accessibility: \(axOK)")
if !axOK {
    logErr("[mirror] INPUT IS DISABLED: synthesized clicks/keys silently no-op without Accessibility.")
    logErr("[mirror] Fix: System Settings > Privacy & Security > Accessibility, enable the app you launched this FROM")
    logErr("[mirror]      (your Terminal/iTerm if using run.sh), then re-run. Capture works regardless.")
}

let delegate = AppDelegate(config: cfg)
let nsApp = NSApplication.shared
nsApp.delegate = delegate
nsApp.setActivationPolicy(.regular)
nsApp.run()
