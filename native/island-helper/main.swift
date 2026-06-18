// BlitzIsland — the faceless macOS notch-HUD helper for BlitzOS (plans/blitzos-dynamic-island.md).
//
// A single-file .accessory agent (no Dock icon, no menu bar — LSUIElement). The SHELL faithfully
// reproduces the notch-HUD behavior of the boring.notch reference; only the CONTENT inside the open
// island is ours (BlitzOS process tabs; a placeholder in P0a). It:
//   - floats a borderless, non-activating NSPanel of a FIXED size (windowSize = openNotch + shadow),
//     pinned top-center on the active screen. The WINDOW NEVER RESIZES (this is the anti-flicker rule:
//     an earlier version animated the window frame on hover, so the window grew under the cursor and the
//     hover tracking thrashed — massive flicker). Instead the CONTENT animates.
//   - hosts a SwiftUI view (NSHostingView): a BLACK `NotchShape` (concave top fillets + convex rounded
//     bottom) whose size animates between the real closed notch dimensions and the open size via the
//     reference's spring feel; SwiftUI's .onHover opens on enter and closes on a debounced exit, so a
//     stationary cursor over a growing shape never fires a spurious exit.
//   - registers a Carbon RegisterEventHotKey for ⌥Space that toggles open/close (a true global hotkey
//     with no Accessibility grant — the reason Carbon, not a global NSEvent monitor).
//   - re-pins (origin only, no resize) on display/resolution/menu-bar changes (didChangeScreenParameters).
//   - runs a URLSessionWebSocketTask client to BlitzOS's local /island endpoint (url+token read fresh
//     from ~/.blitzos/session.json each attempt), ping→pong stub + reconnect-with-backoff that never
//     crashes when the server is absent.
//
// CLEAN ROOM: the boring.notch reference (.repos/boring.notch, GPL-3.0) was STUDIED to learn the notch
// HUD DESIGN — a fixed window with content that animates between a real-notch-sized closed state and an
// open state, a black rounded shape with concave top corners, and hover-open/debounced-close. The
// NotchShape here is the FUNCTIONAL notch outline (its geometry is dictated by the hardware notch),
// derived independently; the window/state/animation are reimplemented, not copied. The WS client and
// the Carbon hotkey are entirely original to BlitzOS.

import Foundation
import AppKit
import SwiftUI
import Carbon.HIToolbox          // RegisterEventHotKey, kVK_Space, optionKey, EventHotKeyID, …
import UniformTypeIdentifiers    // UTType.fileURL for .onDrop(of: [.fileURL]) (drag files onto the island)

// ============================================================================================
// SIZING + ANIMATION (the design constants)
// ============================================================================================
let openNotchSize  = CGSize(width: 640, height: 190)
let shadowPadding: CGFloat = 20
// The window is FIXED at this size for the lifetime of a screen config; only the content animates.
let windowSize     = CGSize(width: openNotchSize.width, height: openNotchSize.height + shadowPadding)

let closedTopRadius: CGFloat = 6,  closedBottomRadius: CGFloat = 14
let openTopRadius:   CGFloat = 19, openBottomRadius:   CGFloat = 24

// Spring feel: a slightly bouncy open, a firmer settle on close (no overshoot).
let openSpring  = Animation.spring(response: 0.42, dampingFraction: 0.80, blendDuration: 0)
let closeSpring = Animation.spring(response: 0.45, dampingFraction: 1.00, blendDuration: 0)

let kCloseHoverDebounce: TimeInterval = 0.12   // re-check "still not hovering" before closing

// ============================================================================================
// NOTCH GEOMETRY — closed size from the active screen
// ============================================================================================
func computeClosedNotchSize(_ screen: NSScreen?) -> CGSize {
    guard let s = screen ?? NSScreen.main ?? NSScreen.screens.first else {
        return CGSize(width: 185, height: 32)
    }
    // WIDTH: the gap between the two auxiliary top areas == the physical notch width (+ a hair of overlap
    // so the pill reads continuous with the notch). Fallback 185 on non-notched displays.
    var width: CGFloat = 185
    if let l = s.auxiliaryTopLeftArea?.width, let r = s.auxiliaryTopRightArea?.width {
        width = s.frame.width - l - r + 4
    }
    // HEIGHT: the safe-area top inset is the true notch height; else the menu-bar band.
    let top = s.safeAreaInsets.top
    let height = top > 0 ? top : max(s.frame.maxY - s.visibleFrame.maxY, 1)
    return CGSize(width: max(width, 1), height: max(height, 1))
}

// ============================================================================================
// NotchShape — the FUNCTIONAL notch outline (concave top fillets, convex rounded bottom), derived
// independently from the hardware-notch geometry (see the CLEAN ROOM note). SwiftUI coordinate space
// is y-DOWN, so the top edge (flush with the menu bar) is minY and the rounded bottom is maxY.
// ============================================================================================
struct NotchShape: Shape {
    var topRadius: CGFloat
    var bottomRadius: CGFloat

    var animatableData: AnimatablePair<CGFloat, CGFloat> {
        get { AnimatablePair(topRadius, bottomRadius) }
        set { topRadius = newValue.first; bottomRadius = newValue.second }
    }

    func path(in rect: CGRect) -> Path {
        var p = Path()
        let left = rect.minX, right = rect.maxX, top = rect.minY, bot = rect.maxY
        let t = max(0, min(topRadius, rect.width / 2))
        let b = max(0, min(bottomRadius, min(rect.height - t, (rect.width - 2 * t) / 2)))

        p.move(to: CGPoint(x: left, y: top))                                   // top-left, on the menu-bar line
        // concave top-left fillet: the top edge melts down into the left wall
        p.addQuadCurve(to: CGPoint(x: left + t, y: top + t),
                       control: CGPoint(x: left + t, y: top))
        p.addLine(to: CGPoint(x: left + t, y: bot - b))                        // left wall
        // convex bottom-left round
        p.addQuadCurve(to: CGPoint(x: left + t + b, y: bot),
                       control: CGPoint(x: left + t, y: bot))
        p.addLine(to: CGPoint(x: right - t - b, y: bot))                       // bottom edge
        // convex bottom-right round
        p.addQuadCurve(to: CGPoint(x: right - t, y: bot - b),
                       control: CGPoint(x: right - t, y: bot))
        p.addLine(to: CGPoint(x: right - t, y: top + t))                       // right wall
        // concave top-right fillet
        p.addQuadCurve(to: CGPoint(x: right, y: top),
                       control: CGPoint(x: right - t, y: top))
        p.closeSubpath()
        return p
    }
}

// ============================================================================================
// PROCESS TABS — value types the model + views share. One `Proc` per BlitzOS chat tab the bridge
// reports; `Line` is one appended reply/activity line. Both Equatable so SwiftUI diffs cheaply.
// ============================================================================================
struct Proc: Identifiable, Equatable {
    let id: String
    var title: String
    var state: String          // new|working|waiting|idle|stopped|error  (island contract)
}

struct Line: Identifiable, Equatable {
    let id = UUID()
    let at: Double             // ms epoch (process.event line.at)
    let text: String
}

// ============================================================================================
// MODEL — the open/closed state machine + the process-tab store (the mutable state the view observes)
// ============================================================================================
// A plain ObservableObject (not @MainActor): all mutation happens on the main thread at runtime
// (AppKit delegate callbacks, the hotkey's main-queue dispatch, SwiftUI's main-actor body, and the WS
// completions which run on delegateQueue:.main + hop to main before touching @Published), so the
// single-file executable's nonisolated top-level entry can construct it without actor friction.
final class IslandModel: ObservableObject {
    // --- shell (unchanged) ---
    @Published var open = false
    @Published var closedSize = CGSize(width: 185, height: 32)

    var notchSize: CGSize { open ? openNotchSize : closedSize }

    func refreshClosed(for screen: NSScreen?) { closedSize = computeClosedNotchSize(screen) }
    func setOpen(_ v: Bool) {
        // Closing the island must end any in-flight chat edit so a closed island never leaves the
        // panel holding the key window (the canBecomeKey-flag invariant — see IslandPanel/setChatEditing).
        if !v { setChatEditing(false) }
        open = v
    }
    func toggle() {
        // On the CLOSED->OPEN edge, ensure we land on a FRESH chat bar so the first Send SPAWNS a new agent
        // (BUG-1). Cold start / ⌥Space leaves currentTabId == nil, so without this sendCurrent's
        // `guard let id = currentTabId` short-circuits and the first Send is a dead no-op. On the OPEN->CLOSED
        // edge, route through the end-edit chokepoint (the canBecomeKey-flag invariant).
        if open { setChatEditing(false) } else { ensureChatBarForOpen() }
        open.toggle()
    }

    // Open onto a FRESH local-draft chat bar UNLESS we're already on a usable one. Correct cold-start guard:
    // a nil selection (cold start / ⌥Space, currentTabId == nil) MUST fall through to newTab() — otherwise the
    // first Send is a dead no-op (sendCurrent's `guard let id = currentTabId` short-circuits, and
    // draftForCurrent's nil-guarded setter silently drops keystrokes). So nil falls through FIRST. The ONLY
    // "do nothing" cases are: we're already sitting on a usable fresh chat bar — the live local draft
    // (currentTabId == localDraftTabId) OR a server 'new' tab (a chat bar whose first Send still spawns).
    // OTHERWISE (sitting on a working / non-new tab) make a new local draft so currentIsChatBar becomes true
    // (the ChatBar renders), currentTabId is set (sendCurrent's guard passes), and Send takes the
    // socket?.spawn branch -> a NEW agent. (NOT the rejected `currentIsChatBar == false` guard: currentIsChatBar
    // is TRUE on a nil selection, so that guard would SKIP newTab() exactly when it's needed; NOT `currentTabId
    // == nil` as an early-RETURN either — that is the inverted polarity that left cold start a dead no-op.)
    func ensureChatBarForOpen() {
        guard currentTabId != nil else { newTab(); return }
        if (localDraftTabId != nil && currentTabId == localDraftTabId)
            || (currentProc?.state ?? "") == "new" { return }
        newTab()
    }

    // --- keyboard focus seam (mechanism lives on IslandPanel; the model is the single chokepoint) ---
    // `editing` is the SwiftUI-side mirror of "a chat field wants keystrokes"; views bind a @FocusState
    // to it. setChatEditing is the ONE place the begin/end invariant lives (flag flip + makeKey/resign on
    // the panel), so every begin-edit has a symmetric end-edit. The panel is set after both exist.
    @Published var editing = false
    weak var panel: IslandPanel?
    func setChatEditing(_ on: Bool) {
        // Order is load-bearing on begin: panel.editing=true (permits key) -> panel.makeKey() ->
        // SwiftUI focus (the view's .onChange(of: editing) sets @FocusState true). On end: drop focus
        // (the view clears @FocusState) -> editing=false (can no longer steal key) -> resignKey.
        if on {
            panel?.editing = true
            panel?.makeKeyAndOrderFront(nil)   // becomes key WITHOUT activating the app (.nonactivatingPanel)
            if editing != true { editing = true }
        } else {
            if editing != false { editing = false }
            panel?.makeFirstResponder(nil)     // drop the field editor / first responder
            panel?.editing = false             // revert to a window that cannot become key
            panel?.resignKey()                 // key window flows back to the user's app (it kept activation)
        }
    }

    // --- tabs / content (the process-tab store) ---
    @Published var processes: [Proc] = []
    @Published var currentTabId: String? = nil
    @Published var messagesByTab: [String: [Line]] = [:]
    @Published var draftByTab: [String: String] = [:]
    @Published var orchestratorsByTab: [String: Bool] = [:]   // default OFF (read with ?? false everywhere)
    @Published var attachedPathsByTab: [String: [String]] = [:]

    // A purely-local "+" tab (no server id yet). Its prompt becomes process.spawn; on the server's first
    // process.upsert/list we ADOPT it (rename localId -> real id) so its draft + attached paths survive the
    // new->working flip. Until then it is the current tab and is pinned LAST in tabOrder.
    @Published var localDraftTabId: String? = nil

    weak var socket: IslandSocket?   // set in AppDelegate after both exist; outbound sends route here

    // ---- accessors the views use ----
    var currentProc: Proc? { processes.first { $0.id == currentTabId } }
    var orchestratorsForCurrent: Bool { currentTabId.map { orchestratorsByTab[$0] ?? false } ?? false }
    var draftForCurrent: String {
        get { currentTabId.flatMap { draftByTab[$0] } ?? "" }
        set { if let id = currentTabId { draftByTab[id] = newValue } }
    }
    var pathsForCurrent: [String] { currentTabId.flatMap { attachedPathsByTab[$0] } ?? [] }

    // display order = server processes, then the un-adopted local "+" tab pinned last
    var tabOrder: [String] {
        var ids = processes.map { $0.id }
        if let l = localDraftTabId, !ids.contains(l) { ids.append(l) }
        return ids
    }
    // is the current tab a brand-new chat bar (server state 'new' OR the local "+" tab)?
    var currentIsChatBar: Bool {
        if let id = currentTabId, id == localDraftTabId { return true }
        return (currentProc?.state ?? "new") == "new"
    }

    // ---- inbound routing (called from IslandSocket.handleText, already on main) ----
    func applyList(_ procs: [Proc]) {
        // FULL snapshot = source of truth + the ONLY channel that prunes a vanished id (per-id upserts can add/
        // edit but never remove). The bridge re-snapshots on connect, on reconnect, and on any MEMBERSHIP delta
        // — a closed agent, a workspace switch (the whole set swaps) — so this is reached whenever a chip must
        // disappear. Reconcile idempotently, preserving the local "+" tab while still un-adopted.
        let serverIds = Set(procs.map { $0.id })
        // adopt: if a brand-new server id appeared while a localDraftTab exists, migrate its draft/paths.
        if let local = localDraftTabId, let adopted = procs.first(where: { p in
            !processes.contains(where: { $0.id == p.id })   // an id we hadn't seen before
        }) {
            migrateLocal(local, to: adopted.id)
        }
        processes = procs
        // keep selection valid (never clobber the still-pending local tab)
        if let cur = currentTabId, !serverIds.contains(cur), cur != localDraftTabId {
            currentTabId = procs.first?.id ?? localDraftTabId
        }
        if currentTabId == nil { currentTabId = procs.first?.id ?? localDraftTabId }
        // GC stale per-tab maps (but NEVER the un-adopted local tab's)
        for key in Array(messagesByTab.keys) where !serverIds.contains(key) && key != localDraftTabId {
            messagesByTab[key] = nil
        }
        for key in Array(draftByTab.keys) where !serverIds.contains(key) && key != localDraftTabId {
            draftByTab[key] = nil
        }
        for key in Array(orchestratorsByTab.keys) where !serverIds.contains(key) && key != localDraftTabId {
            orchestratorsByTab[key] = nil
        }
        for key in Array(attachedPathsByTab.keys) where !serverIds.contains(key) && key != localDraftTabId {
            attachedPathsByTab[key] = nil
        }
    }

    func applyUpsert(id: String, title: String?, state: String?) {
        if let i = processes.firstIndex(where: { $0.id == id }) {
            if let t = title { processes[i].title = t }       // <- this IS the new->working auto-rename
            if let s = state { processes[i].state = s }
        } else {
            // a spawn we just issued (or a foreign new tab) — adopt a pending local draft if present. migrateLocal
            // RENAMES the optimistic local Proc to `id` (so the chip we already show becomes the real tab); after
            // it, re-resolve the index — the entry now exists under `id` — and upsert in place. Only append when
            // still absent (no local draft to adopt). This is what stops the dead "working…" twin: pre-fix the
            // local Proc survived migrate untouched and this branch appended a SECOND Proc for the real id.
            let wasOnLocalDraft = (currentTabId != nil && currentTabId == localDraftTabId)
            if let local = localDraftTabId { migrateLocal(local, to: id) }
            if let i = processes.firstIndex(where: { $0.id == id }) {
                if let t = title { processes[i].title = t }
                if let s = state { processes[i].state = s }
            } else {
                processes.append(Proc(id: id, title: title ?? "working…", state: state ?? "working"))
            }
            // Steer selection onto the freshly-adopted/created tab exactly as before (migrateLocal already moved
            // currentTabId local->id when the user was on that draft; this also covers the no-selection case).
            if currentTabId == nil || wasOnLocalDraft { currentTabId = id }
        }
    }

    func appendEvent(id: String, line: Line) {
        messagesByTab[id, default: []].append(line)
        // cap to keep the small space cheap (older lines drop; full history isn't the island's job)
        if messagesByTab[id]!.count > 200 { messagesByTab[id]!.removeFirst(messagesByTab[id]!.count - 200) }
    }

    private func migrateLocal(_ local: String, to real: String) {
        if local == real { return }
        messagesByTab[real] = messagesByTab[local];           messagesByTab[local] = nil
        draftByTab[real] = draftByTab[local];                 draftByTab[local] = nil
        orchestratorsByTab[real] = orchestratorsByTab[local]; orchestratorsByTab[local] = nil
        attachedPathsByTab[real] = attachedPathsByTab[local]; attachedPathsByTab[local] = nil
        if currentTabId == local { currentTabId = real }
        localDraftTabId = nil
        // RENAME the optimistic local Proc in the array (NOT just the per-tab dictionaries). sendCurrent
        // appends an optimistic Proc(id: localDraftTabId, "working…") so the body flips to the message list at
        // once; on adoption that entry must BECOME the real id, else applyUpsert appends a SECOND Proc and the
        // dead "working…" local chip lingers the whole session (only a fresh process.list snapshot ever cleared
        // it). If a Proc for `real` already exists (a process.list arrived first), drop the local instead of
        // creating a duplicate; otherwise rename the local entry in place, preserving its title/state.
        if let li = processes.firstIndex(where: { $0.id == local }) {
            if processes.contains(where: { $0.id == real }) {
                processes.remove(at: li)
            } else {
                processes[li] = Proc(id: real, title: processes[li].title, state: processes[li].state)
            }
        }
    }

    // ---- tab ops the UI calls ----
    func newTab() {
        let id = "local-" + UUID().uuidString
        localDraftTabId = id
        currentTabId = id
        orchestratorsByTab[id] = false
    }
    func selectTab(_ id: String) { currentTabId = id }
    func selectAdjacent(_ delta: Int) {
        let ids = tabOrder
        guard let cur = currentTabId, let i = ids.firstIndex(of: cur), !ids.isEmpty else { return }
        currentTabId = ids[(i + delta + ids.count) % ids.count]
    }

    // ---- attach ----
    func attach(_ paths: [String]) {
        guard let id = currentTabId else { return }
        var cur = attachedPathsByTab[id] ?? []
        for p in paths where !cur.contains(p) { cur.append(p) }
        attachedPathsByTab[id] = cur
    }
    func clearAttachments(_ id: String) { attachedPathsByTab[id] = nil }

    // ---- outbound (encode + ws send via the socket) ----
    func sendCurrent() {
        guard let id = currentTabId else { return }
        let text = (draftByTab[id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let paths = attachedPathsByTab[id] ?? []
        if currentIsChatBar {
            socket?.spawn(prompt: text, paths: paths, orchestrators: orchestratorsByTab[id] ?? false)
            // optimistic: mark the local tab working so the UI flips to the message list immediately;
            // the server's process.upsert (real id + title) will adopt + replace it.
            if id == localDraftTabId, !processes.contains(where: { $0.id == id }) {
                processes.append(Proc(id: id, title: "working…", state: "working"))
            }
        } else {
            socket?.message(id: id, text: text, paths: paths)
        }
        draftByTab[id] = ""
        clearAttachments(id)
    }
    func setOrchestrators(_ on: Bool) {
        guard let id = currentTabId else { return }
        orchestratorsByTab[id] = on
        // only an EXISTING (server) working tab flips live; a chat-bar/new tab the server doesn't know
        // yet just carries the toggle into the next process.spawn.
        if !currentIsChatBar { socket?.orchestrators(id: id, on: on) }
    }
}

// ============================================================================================
// VIEW — black NotchShape that animates closed<->open inside the fixed window; hover + content
// ============================================================================================
struct IslandRootView: View {
    @ObservedObject var model: IslandModel
    @State private var hovering = false

    var body: some View {
        let size = model.notchSize
        // ZStack fills the FIXED window; only the notch element is hit-testable so clicks elsewhere in
        // the (transparent) window pass through.
        ZStack(alignment: .top) {
            Color.clear.allowsHitTesting(false)

            VStack(spacing: 0) {
                if model.open {
                    IslandTabsView(model: model)
                        .padding(.horizontal, 14)
                        .padding(.bottom, 12)
                        .transition(.opacity)
                }
            }
            .frame(width: size.width, height: size.height, alignment: .top)
            .background(Color.black)
            .clipShape(NotchShape(topRadius:    model.open ? openTopRadius    : closedTopRadius,
                                  bottomRadius: model.open ? openBottomRadius : closedBottomRadius))
            .shadow(color: Color.black.opacity(model.open ? 0.45 : 0.0),
                    radius: model.open ? 10 : 0, x: 0, y: model.open ? 4 : 0)
            .onHover { h in
                hovering = h
                if h {
                    model.setOpen(true)
                } else {
                    // Debounced close: a stationary cursor over a growing shape can briefly report a
                    // false exit; re-check before closing.
                    DispatchQueue.main.asyncAfter(deadline: .now() + kCloseHoverDebounce) {
                        if !hovering { model.setOpen(false) }
                    }
                }
            }
            // Animate the size + radii changes when the state flips. The WINDOW is fixed; this animates
            // the CONTENT only — no flicker.
            .animation(model.open ? openSpring : closeSpring, value: model.open)
        }
        .frame(width: windowSize.width, height: windowSize.height, alignment: .top)
    }
}

// ============================================================================================
// PROCESS-TAB CONTENT — the UI inside the OPEN island (the closed notch stays the bare black pill).
// A tab strip (one chip per process + a "+" new-tab) over a per-tab body that is either a CHAT BAR
// (state=='new' / the local "+" tab → process.spawn) or a concise MESSAGE LIST (working → process.message).
// Sizes target the 640×190 open island (≈612 wide after ±14 padding, ≈130-tall body under the strip).
// ============================================================================================
struct IslandTabsView: View {
    @ObservedObject var model: IslandModel

    var body: some View {
        VStack(spacing: 8) {
            TabStrip(model: model)
            Divider().overlay(Color.white.opacity(0.08))
            // per-tab body: chat bar (new) OR message list (working/…)
            Group {
                if model.currentIsChatBar {
                    ChatBar(model: model)
                } else {
                    MessageList(model: model)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        // HORIZONTAL SWIPE switches prev/next tab (a low-distance, mostly-horizontal drag). minimumDistance
        // keeps it from eating taps/clicks; the width>height guard keeps vertical scrolls from switching tabs.
        .gesture(
            DragGesture(minimumDistance: 24)
                .onEnded { v in
                    guard abs(v.translation.width) > abs(v.translation.height) else { return }
                    model.selectAdjacent(v.translation.width < 0 ? +1 : -1)   // swipe left -> next
                }
        )
        // Drag files onto the OPEN island -> attach to the current tab. Lives on the open content view so
        // it never interferes with the closed-pill .onHover (no regressing hover-open while dragging).
        .onDrop(of: [.fileURL], isTargeted: nil) { providers in handleDrop(providers, model) }
    }
}

struct TabStrip: View {
    @ObservedObject var model: IslandModel
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(model.tabOrder, id: \.self) { id in
                    TabChip(id: id, model: model)
                }
                Button { model.newTab() } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(.white.opacity(0.7))
                        .frame(width: 22, height: 22)
                        .background(Color.white.opacity(0.08), in: Capsule())
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 2)
        }
        .frame(height: 26)
    }
}

struct TabChip: View {
    let id: String
    @ObservedObject var model: IslandModel
    private var proc: Proc? { model.processes.first { $0.id == id } }
    private var isCurrent: Bool { model.currentTabId == id }
    private var title: String { proc?.title ?? "new" }     // the local "+" tab (no proc yet) shows "new"
    private var state: String { proc?.state ?? "new" }
    var body: some View {
        Button { model.selectTab(id) } label: {
            HStack(spacing: 5) {
                Circle().fill(dotColor(state)).frame(width: 6, height: 6)   // small state dot
                Text(title)
                    .font(.system(size: 11, weight: isCurrent ? .semibold : .regular))
                    .lineLimit(1).truncationMode(.tail)
                    .foregroundColor(.white.opacity(isCurrent ? 0.95 : 0.6))
            }
            .padding(.horizontal, 9).padding(.vertical, 4)
            .background(Color.white.opacity(isCurrent ? 0.14 : 0.06), in: Capsule())
        }
        .buttonStyle(.plain)
    }
}

// State dot color (maps the 6 island states; `new` uses the BlitzOS accent #e31c30 from the plan's tokens).
func dotColor(_ s: String) -> Color {
    switch s {
    case "working": return .green
    case "waiting": return .yellow
    case "idle":    return .gray
    case "stopped": return Color.white.opacity(0.35)
    case "error":   return .red
    default:        return Color(red: 0xE3 / 255, green: 0x1C / 255, blue: 0x30 / 255)  // new
    }
}

// --- Chat bar (state == new / fresh "+" tab) → process.spawn ---
struct ChatBar: View {
    @ObservedObject var model: IslandModel
    @FocusState private var fieldFocused: Bool      // SwiftUI's "a field wants keys" signal (focus seam)

    var body: some View {
        VStack(spacing: 8) {
            AttachChips(model: model)                // dropped files as small chips
            // multiline prompt field
            TextEditor(text: Binding(get: { model.draftForCurrent },
                                     set: { model.draftForCurrent = $0 }))
                .focused($fieldFocused)
                .font(.system(size: 12))
                .foregroundColor(.white)
                .scrollContentBackground(.hidden)     // macOS 13+: hide TextEditor's default opaque bg
                .padding(8)
                .frame(minHeight: 36, maxHeight: 64)
                .background(Color.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 8))
            HStack {
                // workflow (orchestrators) toggle — DEFAULT OFF
                Toggle(isOn: Binding(get: { model.orchestratorsForCurrent },
                                     set: { model.setOrchestrators($0) })) {
                    Text("Workflow").font(.system(size: 11)).foregroundColor(.white.opacity(0.7))
                }
                .toggleStyle(.switch).controlSize(.mini)
                Spacer()
                Button { model.sendCurrent(); fieldFocused = false } label: {   // resign on send (focus edge)
                    Image(systemName: "arrow.up.circle.fill").font(.system(size: 20))
                }
                .buttonStyle(.plain)
                .foregroundColor(.white.opacity(model.draftForCurrent.isEmpty ? 0.3 : 0.95))
                .disabled(model.draftForCurrent.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(.top, 2)
        // FOCUS SEAM: keep SwiftUI @FocusState and the panel's key-flag in lockstep through the single
        // model.setChatEditing chokepoint, so begin/end edits are symmetric (the panel becomes key only
        // while a field is focused, never latched). model.editing is cleared on island close/toggle.
        .onChange(of: fieldFocused) { focused in model.setChatEditing(focused) }
        .onChange(of: model.editing) { wants in if fieldFocused != wants { fieldFocused = wants } }
        .onChange(of: model.currentTabId) { _ in fieldFocused = false }   // switching tabs drops focus
    }
}

// --- Message list (state == working/waiting/idle/…) → process.message ---
struct MessageList: View {
    @ObservedObject var model: IslandModel
    @FocusState private var fieldFocused: Bool      // same focus seam as ChatBar
    @State private var expanded: Set<UUID> = []

    private var lines: [Line] { model.currentTabId.flatMap { model.messagesByTab[$0] } ?? [] }

    var body: some View {
        VStack(spacing: 6) {
            ScrollViewReader { proxy in
                ScrollView(.vertical, showsIndicators: false) {
                    LazyVStack(alignment: .leading, spacing: 4) {
                        ForEach(lines) { line in
                            Text(line.text)
                                .font(.system(size: 11))
                                .foregroundColor(.white.opacity(0.85))
                                .lineLimit(expanded.contains(line.id) ? nil : 1)   // 1 line, tap to expand
                                .truncationMode(.tail)
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .contentShape(Rectangle())
                                .onTapGesture {
                                    if expanded.contains(line.id) { expanded.remove(line.id) }
                                    else { expanded.insert(line.id) }
                                }
                                .id(line.id)
                        }
                    }
                    .padding(.horizontal, 2)
                }
                .onChange(of: lines.count) { _ in
                    if let last = lines.last?.id { withAnimation { proxy.scrollTo(last, anchor: .bottom) } }
                }
            }
            // the same input row at the bottom to CONTINUE the process
            AttachChips(model: model)
            HStack(spacing: 6) {
                Toggle(isOn: Binding(get: { model.orchestratorsForCurrent },        // flips live -> process.orchestrators
                                     set: { model.setOrchestrators($0) })) {
                    Text("WF").font(.system(size: 10)).foregroundColor(.white.opacity(0.6))
                }
                .toggleStyle(.switch).controlSize(.mini).labelsHidden()
                TextField("Reply…", text: Binding(get: { model.draftForCurrent },
                                                  set: { model.draftForCurrent = $0 }))
                    .textFieldStyle(.plain).font(.system(size: 12)).foregroundColor(.white)
                    .focused($fieldFocused)
                    .padding(.horizontal, 8).padding(.vertical, 5)
                    .background(Color.white.opacity(0.07), in: Capsule())
                    .onSubmit { model.sendCurrent(); fieldFocused = false }
                Button { model.sendCurrent(); fieldFocused = false } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.system(size: 18))
                }
                .buttonStyle(.plain).foregroundColor(.white.opacity(0.9))
            }
        }
        // FOCUS SEAM (identical to ChatBar): @FocusState <-> panel key-flag via model.setChatEditing.
        .onChange(of: fieldFocused) { focused in model.setChatEditing(focused) }
        .onChange(of: model.editing) { wants in if fieldFocused != wants { fieldFocused = wants } }
        .onChange(of: model.currentTabId) { _ in fieldFocused = false }
    }
}

// --- Drag-attach chips + the drop handler ---
struct AttachChips: View {
    @ObservedObject var model: IslandModel
    var body: some View {
        let paths = model.pathsForCurrent
        if !paths.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 5) {
                    ForEach(paths, id: \.self) { p in
                        HStack(spacing: 4) {
                            // NSWorkspace.icon(forFile:) gives the Finder icon (the reference's drag visual)
                            Image(nsImage: NSWorkspace.shared.icon(forFile: p))
                                .resizable().frame(width: 13, height: 13)
                            Text((p as NSString).lastPathComponent)
                                .font(.system(size: 10)).foregroundColor(.white.opacity(0.8)).lineLimit(1)
                        }
                        .padding(.horizontal, 7).padding(.vertical, 3)
                        .background(Color.white.opacity(0.10), in: Capsule())
                    }
                }
            }
            .frame(height: 22)
        }
    }
}

// Resolve dropped .fileURL providers to local paths, attach to the CURRENT tab. Async load → main hop.
func handleDrop(_ providers: [NSItemProvider], _ model: IslandModel) -> Bool {
    var got = false
    for p in providers where p.canLoadObject(ofClass: URL.self) {
        got = true
        _ = p.loadObject(ofClass: URL.self) { url, _ in
            guard let url = url, url.isFileURL else { return }
            DispatchQueue.main.async { model.attach([url.path]) }
        }
    }
    return got
}

// ============================================================================================
// IslandPanel : NSPanel — the always-on, non-activating notch window (FIXED size)
// ============================================================================================
final class IslandPanel: NSPanel {
    init() {
        super.init(contentRect: NSRect(origin: .zero, size: windowSize),
                   styleMask: [.borderless, .nonactivatingPanel],
                   backing: .buffered, defer: false)
        isFloatingPanel = true
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        isMovable = false
        titleVisibility = .hidden
        titlebarAppearsTransparent = true
        isReleasedWhenClosed = false
        // NSWindow.Level is a STRUCT — `.mainMenu + 3` does NOT compile; do the rawValue arithmetic.
        level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue + 3)
        collectionBehavior = [.fullScreenAuxiliary, .stationary, .canJoinAllSpaces, .ignoresCycle]
        // CRITICAL: NSPanel defaults hidesOnDeactivate = YES, which would vanish the always-on island
        // the moment another app is focused (the exact BlitzOS launcher bug). Must be false.
        hidesOnDeactivate = false
        // becomesKeyOnlyIfNeeded stays at its default (false): canBecomeKey is already demand-driven via
        // the `editing` flag + an explicit makeKey(), so this would only add a redundant condition.
    }

    // KEYBOARD FOCUS for the inline chat field (CLEAN ROOM — original to BlitzOS; the boring.notch
    // reference's notch panel is canBecomeKey{false} with NO inline-notch input, and its only editable
    // text lives in SEPARATE activating .titled windows — the WRONG recipe for a non-activating notch).
    //
    // The panel must NOT become key at rest (a key non-activating panel that can always steal the key
    // window would defeat the always-on HUD). But a window that can NEVER become key gets no field
    // editor, so a TextField in it receives ZERO keystrokes. The fix: make canBecomeKey DYNAMIC — true
    // ONLY while `editing` is set (flipped by setChatEditing). Because the panel is .nonactivatingPanel +
    // isFloatingPanel, it can host the key window WITHOUT the app activating, so keystrokes route to the
    // field while the user's frontmost app stays frontmost. canBecomeMain stays false: MAIN status is
    // what pulls app-level activation/menu ownership — key-but-not-main is exactly the HUD input mode.
    var editing = false
    override var canBecomeKey: Bool { editing }
    override var canBecomeMain: Bool { false }
}

// ============================================================================================
// WEBSOCKET CLIENT — URLSessionWebSocketTask to BlitzOS /island (unchanged; original to BlitzOS)
// ============================================================================================

struct IslandConfig { let wsURL: URL; let token: String }

// Defensive read of ~/.blitzos/session.json → (http base, token). Either may be missing.
func readSessionLocal() -> (base: String, token: String)? {
    let path = NSHomeDirectory() + "/.blitzos/session.json"
    guard let data = FileManager.default.contents(atPath: path),
          let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let local = root["local"] as? [String: Any],
          let url = local["url"] as? String else { return nil }
    let token = (local["token"] as? String) ?? ""
    return (url, token)
}

// Resolve the connection target FRESH each call (the port changes across BlitzOS restarts; the file
// may not exist yet at first launch). Returns nil = "retry later", never crashes.
func resolveConfig() -> IslandConfig? {
    let args = CommandLine.arguments
    func argValue(_ flag: String) -> String? {
        if let i = args.firstIndex(of: flag), i + 1 < args.count { return args[i + 1] }
        return nil
    }
    let fileLocal = readSessionLocal()
    var base = fileLocal?.base ?? ""
    var token = fileLocal?.token ?? ""

    if let t = argValue("--token") { token = t }
    if let portStr = argValue("--port"), let _ = Int(portStr) {
        base = "http://127.0.0.1:\(portStr)"
    }
    if let connect = argValue("--connect") {
        if let u = URL(string: connect) { return IslandConfig(wsURL: u, token: token) }
        return nil
    }

    guard !base.isEmpty, var comps = URLComponents(string: base) else { return nil }
    comps.scheme = (comps.scheme == "https" ? "wss" : "ws")
    comps.path = "/island"
    comps.queryItems = token.isEmpty ? nil : [URLQueryItem(name: "token", value: token)]
    guard let u = comps.url else { return nil }
    return IslandConfig(wsURL: u, token: token)
}

func jsonEncode(_ obj: [String: Any]) -> String? {
    guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return nil }
    return String(data: data, encoding: .utf8)
}
func jsonDecode(_ text: String) -> [String: Any]? {
    guard let data = text.data(using: .utf8) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
}

final class IslandSocket {
    weak var model: IslandModel?   // set in AppDelegate after both exist; inbound frames route here
    private var task: URLSessionWebSocketTask?
    // GENERATION GUARD: bumped every connect(); each send/receive completion captures the generation it
    // was armed on and bails if stale, so an old task's late callback can't tear down the fresh one.
    private var generation: UInt64 = 0
    private let session = URLSession(configuration: .ephemeral, delegate: nil, delegateQueue: .main)
    private var backoff: TimeInterval = 0.5
    private let maxBackoff: TimeInterval = 10.0
    private var stopped = false
    private var reconnectScheduled = false
    private var helloToken = ""

    func start() { connect() }
    func stop() {
        stopped = true
        generation &+= 1
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    private func connect() {
        guard !stopped else { return }
        guard let cfg = resolveConfig() else { scheduleReconnect(); return }   // no server yet → quiet retry
        NSLog("[island] connecting %@", cfg.wsURL.absoluteString)
        generation &+= 1
        let gen = generation
        let t = session.webSocketTask(with: cfg.wsURL)
        self.task = t
        self.helloToken = cfg.token
        t.resume()
        sendHello(gen: gen)
        receiveLoop(gen: gen, task: t)
    }

    private func sendHello(gen: UInt64) {
        let pid = Int(ProcessInfo.processInfo.processIdentifier)
        let bundleId = Bundle.main.bundleIdentifier ?? "dev.blitz.os.island"
        sendJSON(["t": "hello", "token": helloToken, "pid": pid, "bundleId": bundleId], gen: gen)
    }

    private func sendJSON(_ obj: [String: Any], gen: UInt64? = nil) {
        let g = gen ?? generation
        guard let text = jsonEncode(obj), let t = task else { return }
        t.send(.string(text)) { [weak self] err in
            guard let self = self, g == self.generation else { return }
            if let err = err {
                NSLog("[island] send failed: %@", err.localizedDescription)
                self.handleDrop()
            }
        }
    }

    private func receiveLoop(gen: UInt64, task t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            guard let self = self, gen == self.generation else { return }
            switch result {
            case .failure(let err):
                NSLog("[island] receive failed: %@", err.localizedDescription)
                self.handleDrop()
            case .success(let message):
                switch message {
                case .string(let text): self.handleText(text)
                case .data(let data): if let s = String(data: data, encoding: .utf8) { self.handleText(s) }
                @unknown default: break
                }
                self.backoff = 0.5
                self.receiveLoop(gen: gen, task: t)
            }
        }
    }

    private func handleText(_ text: String) {
        guard let msg = jsonDecode(text) else { NSLog("[island] non-JSON frame ignored"); return }
        let t = (msg["t"] as? String) ?? ""
        switch t {
        case "ping":  sendJSON(["t": "pong"])
        case "hello": NSLog("[island] hello ack")
        case "process.list":
            // FULL snapshot (sent on connect + every change). Tolerate empty / partial entries.
            let arr = (msg["processes"] as? [[String: Any]]) ?? []
            let procs: [Proc] = arr.compactMap { d in
                guard let id = d["id"] as? String else { return nil }
                return Proc(id: id,
                            title: (d["title"] as? String) ?? id,
                            state: (d["state"] as? String) ?? "working")
            }
            // The session completion queue is already .main, but hop explicitly before touching @Published.
            DispatchQueue.main.async { self.model?.applyList(procs) }
        case "process.upsert":
            // Incremental: status change / auto-name. title? + state? are both optional.
            guard let id = msg["id"] as? String else { break }
            let title = msg["title"] as? String
            let state = msg["state"] as? String
            DispatchQueue.main.async { self.model?.applyUpsert(id: id, title: title, state: state) }
        case "process.event":
            // One reply/activity line to append. line.at is an ms-NUMBER (tolerate Int or Double).
            guard let id = msg["id"] as? String,
                  let l = msg["line"] as? [String: Any] else { break }
            let at = (l["at"] as? Double) ?? (l["at"] as? NSNumber)?.doubleValue ?? 0
            let txt = (l["text"] as? String) ?? ""
            DispatchQueue.main.async { self.model?.appendEvent(id: id, line: Line(at: at, text: txt)) }
        default: NSLog("[island] frame: %@", t)
        }
    }

    // --- outbound (mirror the sendJSON path; an empty paths:[] serializes correctly) ---
    func spawn(prompt: String, paths: [String], orchestrators: Bool) {
        sendJSON(["t": "process.spawn", "prompt": prompt, "paths": paths, "orchestrators": orchestrators])
    }
    func message(id: String, text: String, paths: [String]) {
        sendJSON(["t": "process.message", "id": id, "text": text, "paths": paths])
    }
    func orchestrators(id: String, on: Bool) {
        sendJSON(["t": "process.orchestrators", "id": id, "on": on])
    }

    private func handleDrop() {
        generation &+= 1
        task?.cancel(with: .abnormalClosure, reason: nil)
        task = nil
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        guard !stopped, !reconnectScheduled else { return }
        reconnectScheduled = true
        let delay = backoff
        backoff = min(backoff * 2, maxBackoff)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.reconnectScheduled = false
            self?.connect()
        }
    }
}

// ============================================================================================
// CARBON GLOBAL HOTKEY (⌥Space) — toggle open/close (original to BlitzOS)
// ============================================================================================
extension String {
    var fourCharCodeValue: FourCharCode {
        var result: FourCharCode = 0
        for ch in self.utf16.prefix(4) { result = (result << 8) + FourCharCode(ch & 0xFF) }
        return result
    }
}
let kIslandHotKeySignature: OSType = "BLZI".fourCharCodeValue

// FREE FUNCTION (no captures) for a @convention(c)-compatible callback. State arrives via userData.
private func islandHotKeyHandler(_ next: EventHandlerCallRef?, _ event: EventRef?,
                                 _ userData: UnsafeMutableRawPointer?) -> OSStatus {
    if let userData = userData {
        let delegate = Unmanaged<AppDelegate>.fromOpaque(userData).takeUnretainedValue()
        DispatchQueue.main.async { delegate.toggleIsland() }
    }
    return noErr
}

// ============================================================================================
// AppDelegate
// ============================================================================================
final class AppDelegate: NSObject, NSApplicationDelegate {
    var panel: IslandPanel!
    let model = IslandModel()
    var hotKeyRef: EventHotKeyRef?
    let socket = IslandSocket()

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.setActivationPolicy(.accessory)   // faceless; Info.plist LSUIElement too

        model.refreshClosed(for: NSScreen.main)
        panel = IslandPanel()
        panel.contentView = NSHostingView(rootView: IslandRootView(model: model))
        // Wire the three peers: the model drives the panel's key-flag (chat focus chokepoint), and
        // routes outbound frames through the socket; the socket routes inbound frames into the model.
        model.panel = panel
        model.socket = socket
        socket.model = model
        positionPanel()
        panel.orderFrontRegardless()            // show without activating (canBecomeKey is false at rest)

        // safeAreaInsets can settle a hair after launch — recompute + re-pin once.
        DispatchQueue.main.async { [weak self] in
            self?.model.refreshClosed(for: NSScreen.main)
            self?.positionPanel()
        }

        registerHotKey()
        NotificationCenter.default.addObserver(
            self, selector: #selector(screenParamsChanged),
            name: NSApplication.didChangeScreenParametersNotification, object: nil)

        socket.start()
    }

    func applicationWillTerminate(_ note: Notification) {
        if let r = hotKeyRef { UnregisterEventHotKey(r); hotKeyRef = nil }
        NotificationCenter.default.removeObserver(self)
        socket.stop()
    }

    @objc func screenParamsChanged() {
        model.refreshClosed(for: NSScreen.main)
        positionPanel()                          // re-pin ORIGIN only; the window size is fixed (no flicker)
    }

    // Pin the FIXED-size window top-center on the active screen.
    func positionPanel() {
        guard let screen = NSScreen.main ?? NSScreen.screens.first else { return }
        let f = screen.frame
        let origin = NSPoint(x: f.midX - windowSize.width / 2, y: f.maxY - windowSize.height)
        panel.setFrameOrigin(origin)
    }

    func toggleIsland() { model.toggle() }

    func registerHotKey() {
        let hotKeyID = EventHotKeyID(signature: kIslandHotKeySignature, id: 1)
        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                                      eventKind: OSType(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), islandHotKeyHandler, 1, &eventType,
                            UnsafeMutableRawPointer(Unmanaged.passUnretained(self).toOpaque()), nil)
        RegisterEventHotKey(UInt32(kVK_Space), UInt32(optionKey), hotKeyID,
                            GetApplicationEventTarget(), 0, &hotKeyRef)
    }
}

// ============================================================================================
// ENTRY — plain top-level statements (NO @main; conflicts with a single-file top-level build)
// ============================================================================================
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
