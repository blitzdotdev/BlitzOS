import AppKit
import AVFoundation
import CoreGraphics
import FluidAudio
import Foundation

let sampleRate = 16_000
let minHoldSeconds: TimeInterval = 0.25
let partialWindowSamples = 30 * sampleRate
let maxRecordingSeconds: TimeInterval = 120

var conn: HelperConnection?
var controller: DictationController?

func jsonLine(_ obj: [String: Any]) -> Data {
    let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8)
    var line = data
    line.append(0x0A)
    return line
}

func stderr(_ message: String) {
    FileHandle.standardError.write(Data((message + "\n").utf8))
}

func stdout(_ message: String) {
    FileHandle.standardOutput.write(Data((message + "\n").utf8))
}

func isSupportedOS() -> Bool {
    ProcessInfo.processInfo.isOperatingSystemAtLeast(OperatingSystemVersion(majorVersion: 15, minorVersion: 0, patchVersion: 0))
}

func freeBytesForModels() -> Int64 {
    let url = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library", isDirectory: true)
    do {
        let values = try url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        return Int64(values.volumeAvailableCapacityForImportantUsage ?? 0)
    } catch {
        return 0
    }
}

func classifyError(_ error: Error) -> String {
    let text = String(describing: error).lowercased()
    if text.contains("network") || text.contains("offline") || text.contains("timed out") || text.contains("could not connect") {
        return "network"
    }
    if text.contains("space") || text.contains("disk") || text.contains("file") || text.contains("permission") {
        return "disk"
    }
    return "unknown"
}

func fnUsageValue() -> Int {
    let value = CFPreferencesCopyAppValue("AppleFnUsageType" as CFString, kCFPreferencesAnyApplication)
    return (value as? NSNumber)?.intValue ?? 0
}

func microphoneGranted() -> Bool {
    AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
}

func microphoneDenied() -> Bool {
    let status = AVCaptureDevice.authorizationStatus(for: .audio)
    return status == .denied || status == .restricted
}

func tccStatus() -> [String: Bool] {
    [
        "inputMonitoring": CGPreflightListenEventAccess(),
        "microphone": microphoneGranted()
    ]
}

final class HelperConnection: @unchecked Sendable {
    private let fd: Int32
    private var inBuffer = Data()
    private let queue = DispatchQueue(label: "dev.blitz.os.dictation.io")

    init?(socketPath: String) {
        fd = socket(AF_UNIX, SOCK_STREAM, 0)
        if fd < 0 { return nil }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = socketPath.utf8CString
        if pathBytes.count > MemoryLayout.size(ofValue: addr.sun_path) { close(fd); return nil }
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
            var offset = 0
            guard let base = raw.bindMemory(to: UInt8.self).baseAddress else { return }
            while offset < data.count {
                let n = write(fd, base + offset, data.count - offset)
                if n <= 0 { break }
                offset += n
            }
        }
    }

    func run(handle: @escaping ([String: Any]) -> Void) {
        queue.async {
            var chunk = [UInt8](repeating: 0, count: 8192)
            while true {
                let n = read(self.fd, &chunk, chunk.count)
                if n <= 0 { break }
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

final class DictationController: @unchecked Sendable {
    enum ModelPhase: String {
        case absent
        case downloading
        case loading
        case ready
        case error
    }

    private let audioQueue = DispatchQueue(label: "dev.blitz.dictation.audio")
    private let engine = AVAudioEngine()
    private var pcm: [Float] = []
    private var manager: AsrManager?
    private var modelPhase: ModelPhase = .absent
    private var modelReady = false
    private var preparing = false
    private var recordingActive = false
    private var fnDown = false
    private var fnDownAt: Date?
    private var seq = 0
    private var partialTimer: DispatchSourceTimer?
    private var isTranscribing = false
    private var tap: CFMachPort?
    private var lastConflict: Int?

    func start() {
        emitModel(ready: false, phase: .absent)
        installFnTap()
    }

    func emit(_ payload: [String: Any]) {
        var out = payload
        out["type"] = "event"
        out["kind"] = "dictation"
        conn?.send(out)
    }

    func emitModel(ready: Bool, phase: ModelPhase, progress: Double? = nil, error: String? = nil, retryable: Bool? = nil) {
        var payload: [String: Any] = ["state": "model", "ready": ready, "phase": phase.rawValue]
        if let progress { payload["progress"] = progress }
        if let error { payload["error"] = error }
        if let retryable { payload["retryable"] = retryable }
        emit(payload)
    }

    func status() -> [String: Any] {
        [
            "modelReady": modelReady,
            "modelPhase": modelPhase.rawValue,
            "recording": recordingActive,
            "fnUsage": fnUsageValue(),
            "tcc": tccStatus()
        ]
    }

    func prepareModel(force: Bool = false) {
        if preparing { return }
        if modelReady && !force { return }
        if freeBytesForModels() < 2 * 1024 * 1024 * 1024 {
            modelPhase = .error
            emitModel(ready: false, phase: .error, error: "disk", retryable: true)
            return
        }
        preparing = true
        modelReady = false
        modelPhase = .downloading
        emitModel(ready: false, phase: .downloading)
        Task.detached { [weak self] in
            guard let self else { return }
            var lastError: Error?
            for (index, delay) in [0.0, 1.0, 4.0, 10.0].enumerated() {
                if delay > 0 { try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
                do {
                    let models = try await AsrModels.downloadAndLoad(version: .v3) { progress in
                        self.emitModel(ready: false, phase: .downloading, progress: progress.fractionCompleted)
                    }
                    self.emitModel(ready: false, phase: .loading)
                    let mgr = AsrManager(config: .default)
                    try await mgr.initialize(models: models)
                    DispatchQueue.main.async {
                        self.manager = mgr
                        self.modelReady = true
                        self.preparing = false
                        self.modelPhase = .ready
                        self.emitModel(ready: true, phase: .ready)
                    }
                    return
                } catch {
                    lastError = error
                    if index == 3 { break }
                }
            }
            DispatchQueue.main.async {
                self.preparing = false
                self.modelReady = false
                self.modelPhase = .error
                self.emitModel(ready: false, phase: .error, error: classifyError(lastError ?? NSError(domain: "dictation", code: -1)), retryable: true)
            }
        }
    }

    func requestPermissions(reply: @escaping ([String: Any]) -> Void) {
        if !CGPreflightListenEventAccess() {
            emit(["state": "perm", "need": "inputMonitoring", "granted": false])
            _ = CGRequestListenEventAccess()
        }
        let status = AVCaptureDevice.authorizationStatus(for: .audio)
        if status == .notDetermined {
            AVCaptureDevice.requestAccess(for: .audio) { _ in
                DispatchQueue.main.async {
                    reply(["tcc": tccStatus()])
                }
            }
        } else {
            reply(["tcc": tccStatus()])
        }
    }

    private func installFnTap() {
        // Input Monitoring (NOT Accessibility) is the correct grant for OBSERVING keys. Request it here
        // so the user gets the right prompt; it takes effect after the sidecar relaunches.
        if !CGPreflightListenEventAccess() {
            emit(["state": "perm", "need": "inputMonitoring", "granted": false])
            _ = CGRequestListenEventAccess()
        }
        let mask = CGEventMask(1 << CGEventType.flagsChanged.rawValue)
        guard let eventTap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            // .listenOnly => Input Monitoring only (an active .defaultTap would require ACCESSIBILITY,
            // which this sidecar must never request; insertion is delegated to the computer-use helper).
            options: .listenOnly,
            eventsOfInterest: mask,
            callback: fnTapCallback,
            userInfo: nil
        ) else {
            emit(["state": "perm", "need": "inputMonitoring", "granted": false])
            return
        }
        tap = eventTap
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, eventTap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: eventTap, enable: true)
    }

    func reenableTap() {
        if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
    }

    func handleFn(flags: CGEventFlags) {
        let isDown = flags.contains(.maskSecondaryFn)
        if isDown == fnDown { return }
        fnDown = isDown
        if isDown {
            fnDownAt = Date()
            reportFnConflictIfNeeded()
            DispatchQueue.main.asyncAfter(deadline: .now() + minHoldSeconds) { [weak self] in
                guard let self, self.fnDown, !self.recordingActive else { return }
                self.beginRecording()
            }
        } else {
            guard recordingActive else { return }
            stopRecording()
        }
    }

    private func reportFnConflictIfNeeded() {
        let value = fnUsageValue()
        if value != 0 && value != lastConflict {
            lastConflict = value
            emit(["state": "conflict", "fnUsage": value])
        }
    }

    private func beginRecording() {
        if !modelReady {
            prepareModel()
            return
        }
        if microphoneDenied() {
            emit(["state": "perm", "need": "microphone", "granted": false])
            return
        }
        if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                DispatchQueue.main.async {
                    if granted { self.beginRecording() }
                    else { self.emit(["state": "perm", "need": "microphone", "granted": false]) }
                }
            }
            return
        }
        seq += 1
        recordingActive = true
        audioQueue.sync {
            pcm.removeAll(keepingCapacity: true)
            isTranscribing = false
        }
        do {
            try startAudio()
        } catch {
            recordingActive = false
            emit(["state": "perm", "need": "microphone", "granted": false])
            return
        }
        startPartialTimer()
        DispatchQueue.main.asyncAfter(deadline: .now() + maxRecordingSeconds) { [weak self] in
            guard let self, self.recordingActive else { return }
            self.stopRecording()
        }
    }

    private func startAudio() throws {
        let input = engine.inputNode
        let inputFormat = input.inputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, _ in
            guard let self, let converted = self.convert(buffer: buffer, from: inputFormat) else { return }
            self.audioQueue.async {
                self.pcm.append(contentsOf: converted)
            }
        }
        engine.prepare()
        try engine.start()
    }

    private func convert(buffer: AVAudioPCMBuffer, from inputFormat: AVAudioFormat) -> [Float]? {
        guard let outputFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(sampleRate), channels: 1, interleaved: false),
              let converter = AVAudioConverter(from: inputFormat, to: outputFormat) else { return nil }
        let ratio = outputFormat.sampleRate / inputFormat.sampleRate
        let frameCapacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 8
        guard let out = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: frameCapacity) else { return nil }
        var didProvide = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if didProvide {
                status.pointee = .noDataNow
                return nil
            }
            didProvide = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, let channel = out.floatChannelData?[0] else { return nil }
        return Array(UnsafeBufferPointer(start: channel, count: Int(out.frameLength)))
    }

    private func startPartialTimer() {
        partialTimer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: audioQueue)
        timer.schedule(deadline: .now() + 0.4, repeating: 0.4)
        timer.setEventHandler { [weak self] in
            guard let self, self.recordingActive, !self.isTranscribing else { return }
            self.isTranscribing = true
            let currentSeq = self.seq
            let snapshot = Array(self.pcm.suffix(partialWindowSamples))
            self.transcribe(snapshot: snapshot, seq: currentSeq, final: false)
        }
        partialTimer = timer
        timer.resume()
    }

    private func stopRecording() {
        guard recordingActive else { return }
        recordingActive = false
        partialTimer?.cancel()
        partialTimer = nil
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        let currentSeq = seq
        audioQueue.async {
            let snapshot = self.pcm
            self.pcm.removeAll(keepingCapacity: true)
            self.transcribe(snapshot: snapshot, seq: currentSeq, final: true)
        }
    }

    private func transcribe(snapshot: [Float], seq: Int, final: Bool) {
        guard snapshot.count >= sampleRate / 2, let manager else {
            if final { emit(["state": "idle"]) }
            audioQueue.async { self.isTranscribing = false }
            return
        }
        Task.detached { [weak self] in
            guard let self else { return }
            do {
                let result = try await manager.transcribe(snapshot, source: .microphone)
                let text = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
                if final {
                    if !text.isEmpty { self.emit(["state": "final", "text": text, "seq": seq]) }
                    self.emit(["state": "idle"])
                } else if !text.isEmpty {
                    self.emit(["state": "partial", "text": text, "seq": seq])
                }
            } catch {
                if final { self.emit(["state": "idle"]) }
            }
            self.audioQueue.async { self.isTranscribing = false }
        }
    }
}

let fnTapCallback: CGEventTapCallBack = { _, type, event, _ in
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        controller?.reenableTap()
        return Unmanaged.passUnretained(event)
    }
    if type == .flagsChanged {
        controller?.handleFn(flags: event.flags)
    }
    return Unmanaged.passUnretained(event)
}

func socketPathArg() -> String? {
    let args = CommandLine.arguments
    if let i = args.firstIndex(of: "--connect"), i + 1 < args.count { return args[i + 1] }
    return nil
}

func runSay(_ text: String, to url: URL) -> Bool {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/say")
    process.arguments = ["-o", url.path, text]
    do {
        try process.run()
        process.waitUntilExit()
        return process.terminationStatus == 0
    } catch {
        return false
    }
}

func runSelftest(noDownload: Bool) {
    if !isSupportedOS() {
        stdout("SELFTEST FAIL unsupportedOS")
        exit(1)
    }
    let sem = DispatchSemaphore(value: 0)
    Task.detached {
        do {
            if noDownload {
                let valid = try await AsrModels.isModelValid(version: .v3)
                if !valid {
                    stdout("SELFTEST MODEL_ABSENT")
                    exit(2)
                }
            }
            let models = try await AsrModels.downloadAndLoad(version: .v3)
            let mgr = AsrManager(config: .default)
            try await mgr.initialize(models: models)
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("blitz-dictation-selftest-\(UUID().uuidString).aiff")
            guard runSay("hello blitz os this is a short dictation self test sample", to: url) else {
                stdout("SELFTEST FAIL could not synthesize sample")
                exit(1)
            }
            let result = try await mgr.transcribe(url, source: .system)
            try? FileManager.default.removeItem(at: url)
            let text = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty {
                stdout("SELFTEST FAIL empty transcript")
                exit(1)
            }
            stdout("SELFTEST OK text=\(text)")
            exit(0)
        } catch {
            stdout("SELFTEST FAIL \(error)")
            sem.signal()
        }
    }
    sem.wait()
    exit(1)
}

if CommandLine.arguments.contains("--selftest") {
    runSelftest(noDownload: CommandLine.arguments.contains("--selftest-no-download"))
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

guard isSupportedOS() else {
    if let socketPath = socketPathArg(), let liveConn = HelperConnection(socketPath: socketPath) {
        conn = liveConn
        conn?.send(["type": "hello", "bundleId": Bundle.main.bundleIdentifier ?? "dev.blitz.os.dictation", "pid": ProcessInfo.processInfo.processIdentifier])
        conn?.send(["type": "event", "kind": "dictation", "state": "model", "ready": false, "phase": "error", "error": "unsupportedOS"])
    } else {
        stderr("BlitzDictation: unsupportedOS")
    }
    exit(0)
}

guard let socketPath = socketPathArg(), let liveConn = HelperConnection(socketPath: socketPath) else {
    stderr("BlitzDictation: missing or failed --connect <socket>")
    exit(2)
}

conn = liveConn
let bundleId = Bundle.main.bundleIdentifier ?? "dev.blitz.os.dictation"
conn?.send(["type": "hello", "bundleId": bundleId, "pid": ProcessInfo.processInfo.processIdentifier, "tcc": tccStatus()])

let liveController = DictationController()
controller = liveController
liveController.start()

conn?.run { msg in
    let id = msg["id"] as? Int ?? -1
    let cmd = msg["cmd"] as? String ?? ""
    func reply(_ payload: [String: Any]) {
        var out = payload
        out["type"] = "reply"
        out["id"] = id
        conn?.send(out)
    }
    DispatchQueue.main.async {
        switch cmd {
        case "ping":
            reply(["pong": true])
        case "dictation_status":
            reply(liveController.status())
        case "prepare_model":
            liveController.prepareModel(force: msg["force"] as? Bool ?? false)
            reply(["ok": true])
        case "tcc_status":
            reply(["tcc": tccStatus()])
        case "request_perms":
            liveController.requestPermissions(reply: reply)
        case "quit":
            reply(["ok": true])
            NSApp.terminate(nil)
        default:
            reply(["error": "unknown command"])
        }
    }
}

app.run()
