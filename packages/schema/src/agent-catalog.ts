import { HARNESSES } from "./broker.js";

/** The shared model → provider catalog.
 *
 * It mirrors the per-provider model and effort lists the pinned harness CLIs
 * accept; "default" is expressed by omitting the model or effort, so it is not
 * listed. The providers are the TUI harness list (`HARNESSES` in broker.ts) —
 * one constant, derived, never re-spelled. The control plane keeps a
 * byte-identical copy in `control-plane/core/wire.ts` (core code may not
 * import packages); `test/wire-drift.test.ts` holds the two together. Extend
 * both copies in the same change. */
export const AGENT_PROVIDERS = HARNESSES;

export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

export const AGENT_MODELS = {
  claude: ["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
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

/** The per-provider BASE effort lists: every model of the provider accepts at
 * least these, in ascending order. Models that accept more appear in
 * AGENT_MODEL_EFFORTS. */
export const AGENT_EFFORTS = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh"],
} satisfies Record<AgentProvider, readonly string[]>;

/** Per-model effort extensions: only models whose list differs from their
 * provider base appear. The codex gpt-5.6 family adds `max`; sol and terra
 * also add `ultra`. Claude efforts are flat, so no claude model is listed. */
export const AGENT_MODEL_EFFORTS = {
  "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-terra": ["low", "medium", "high", "xhigh", "max", "ultra"],
} satisfies Record<string, readonly string[]>;

function isEffortExtendedModel(model: string): model is keyof typeof AGENT_MODEL_EFFORTS {
  return model in AGENT_MODEL_EFFORTS;
}

/** The effective ordered effort list for one provider and pinned model: the
 * model's extended list when it has one, otherwise the provider base. An
 * absent model (the harness default) always takes the base. */
export function agentEffortsForModel(provider: AgentProvider, model?: string): readonly string[] {
  if (model !== undefined && isEffortExtendedModel(model)) return AGENT_MODEL_EFFORTS[model];
  return AGENT_EFFORTS[provider];
}

/** The provider whose adapter runs a pinned model, or null for a model no
 * provider claims. */
export function agentProviderForModel(model: string): AgentProvider | null {
  return AGENT_PROVIDERS.find((provider) => AGENT_MODELS[provider].includes(model)) ?? null;
}
