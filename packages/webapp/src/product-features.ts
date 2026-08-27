/**
 * Native Chat is intentionally unavailable while Blitz delegates conversation
 * lifecycle and resume behavior to the provider-native Claude and Codex
 * harnesses. Re-enable it only after native Chat is defined as a separately
 * owned product surface with explicit session and authentication semantics.
 */
export const NATIVE_CHAT_ENABLED: boolean = false;
