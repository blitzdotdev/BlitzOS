import { HARNESSES } from "./broker.js";

/** The shared model → provider catalog.
 *
 * It mirrors the per-provider model and effort lists the box actor accepts
 * (`packages/box/actor/src/agent-config.ts`); "default" is expressed by
 * omitting the model or effort, so it is not listed. The providers are the
 * TUI harness list (`HARNESSES` in broker.ts) — one constant, derived, never
 * re-spelled. The control plane keeps a byte-identical copy in
 * `control-plane/core/wire.ts` (core code may not import packages);
 * `test/wire-drift.test.ts` holds the two together. Extend both copies and
 * the actor catalog in the same change. */
export const AGENT_PROVIDERS = HARNESSES;

export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

export const AGENT_MODELS = {
  claude: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
  // Codex CLI user-selectable models; excluded on purpose: codex-auto-review (single-purpose review model), gpt-reserve (routing placeholder).
  codex: [
    "gpt-5.6-sol",
    "gpt-5.6-luna",
    "gpt-5.6-terra",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3-codex-spark",
  ],
} satisfies Record<AgentProvider, readonly string[]>;

export const AGENT_EFFORTS = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high"],
} satisfies Record<AgentProvider, readonly string[]>;

/** The provider whose adapter runs a pinned model, or null for a model no
 * provider claims. */
export function agentProviderForModel(model: string): AgentProvider | null {
  return AGENT_PROVIDERS.find((provider) => AGENT_MODELS[provider].includes(model)) ?? null;
}
