/** The shared model → provider catalog.
 *
 * It mirrors the per-provider model lists the box actor accepts
 * (`packages/box/actor/src/agent-config.ts`); "default" is expressed by
 * omitting the model, so it is not listed. The control plane keeps a
 * byte-identical copy in `control-plane/core/wire.ts` (core code may not
 * import packages); `test/wire-drift.test.ts` holds the two together.
 * Extend both copies and the actor catalog in the same change. */
export const AGENT_PROVIDERS = ["claude", "codex"] as const;

export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

export const AGENT_MODELS = {
  claude: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
  codex: ["gpt-5-codex", "gpt-5"],
} satisfies Record<AgentProvider, readonly string[]>;

/** The provider whose adapter runs a pinned model, or null for a model no
 * provider claims. */
export function agentProviderForModel(model: string): AgentProvider | null {
  return AGENT_PROVIDERS.find((provider) => AGENT_MODELS[provider].includes(model)) ?? null;
}
