// notch-geometry — a tiny faceless CLI that prints the active display's PHYSICAL notch rectangle as JSON, so
// BlitzOS can place its always-interactive notch hit-window EXACTLY over the hardware notch (instead of a 200px
// guess). The math is ported verbatim from native/island-helper/main.swift (computeClosedNotchSize): the notch
// width is the gap between the two menu-bar "ears" (auxiliaryTopLeftArea / auxiliaryTopRightArea), and the notch
// height is the safe-area top inset. No notch (external/older display) => hasNotch:false and BlitzOS draws no band
// (⌥Space only). Reading NSScreen geometry needs NO TCC permission/entitlement.
//
// Output (one JSON line on stdout): { hasNotch, frameWidth, leftAux, rightAux, notchLeft, notchWidth, notchHeight }
// All values are in POINTS relative to the primary display's frame; main.ts combines notchLeft/notchWidth with
// Electron's screen.getPrimaryDisplay().bounds (top-left origin) to get the on-screen rect.
import AppKit
import Foundation

// NSScreen needs an NSApplication context to be populated; .prohibited keeps this faceless (no Dock icon, no run loop).
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

var out: [String: Any] = ["hasNotch": false]

if let s = NSScreen.main ?? NSScreen.screens.first {
  let f = s.frame
  let safeTop = s.safeAreaInsets.top
  let l = s.auxiliaryTopLeftArea?.width
  let r = s.auxiliaryTopRightArea?.width
  // A real hardware notch: both ears exist AND there is a non-zero safe-area top inset.
  let hasNotch = safeTop > 0 && l != nil && r != nil
  let leftAux = l ?? 0
  let rightAux = r ?? 0
  let notchWidth = (l != nil && r != nil) ? max(0, f.width - leftAux - rightAux) : 0
  out = [
    "hasNotch": hasNotch,
    "frameWidth": Double(f.width),
    "leftAux": Double(leftAux),
    "rightAux": Double(rightAux),
    "notchLeft": Double(leftAux), // the notch starts right after the left ear
    "notchWidth": Double(notchWidth),
    "notchHeight": Double(safeTop)
  ]
}

if let data = try? JSONSerialization.data(withJSONObject: out),
  let json = String(data: data, encoding: .utf8) {
  print(json)
} else {
  print("{\"hasNotch\":false}")
}
