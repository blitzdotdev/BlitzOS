/**
 * Stand-in for `acp-extension-dsh/capabilities`.
 *
 * `packages/acp-extension-dsh` is one of the six git submodules that the public
 * Lody tree references but does not contain, so `git subtree add` brought in the
 * gitlink and no sources (plans/LODY-SESSIONS.md §5.1). `@lody/shared`'s index
 * re-exports `deepseek-harness.ts`, which re-exports four DeepSeek selector
 * constants from that package, so any import of `@lody/shared` needs them to
 * exist.
 *
 * Empty is the correct value here, not a placeholder: §0.6 fixes agents v1 at
 * claude and codex, so a DeepSeek harness has no options to offer. Every reader
 * in `packages/shared/src/ai.ts` only maps over these arrays.
 *
 * Wired in by the `acp-extension-dsh/capabilities` alias in `vendor-bridge.ts`.
 */
export const DEEPSEEK_HARNESS_AGENT_PRESETS: readonly {
  value: string;
  name: string;
  description?: string;
}[] = [];

export const DEEPSEEK_HARNESS_MODELS: readonly {
  modelId: string;
  name: string;
  description?: string;
}[] = [];

export const DEEPSEEK_HARNESS_PERMISSION_MODES: readonly {
  id: string;
  name: string;
  description?: string;
}[] = [];

export const DEEPSEEK_HARNESS_REASONING_OPTIONS: readonly {
  value: string;
  name: string;
  description?: string;
}[] = [];
