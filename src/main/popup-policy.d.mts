// Types for the pure popup classifier (popup-policy.mjs).

export type PopupPlan =
  | { kind: 'window'; width: number; height: number } // a sized popup the page requested (OAuth/share) → a real visible window
  | { kind: 'hidden' } // a scripted about:blank utility child (gapi RPC) → real but invisible; self-closes
  | { kind: 'surface' } // a link click → a new web surface on the canvas
  | { kind: 'deny' } // a scripted popup, no size + no gesture (helper frames, popunders) → refuse + swallow the fallback

export interface PopupDetails {
  url?: string
  features?: string
  disposition?: string
  frameName?: string
}

export function parseFeatures(features: string | undefined): Record<string, string>
export function classifyPopup(details: PopupDetails): PopupPlan
