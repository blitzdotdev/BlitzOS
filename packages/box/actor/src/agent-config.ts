import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { Provider } from "./types.js";

export const MODEL_CONFIG_ID = "model";
export const EFFORT_CONFIG_ID = "effort";
export const PERMISSION_CONFIG_ID = "permission";

/** Chosen agent settings for one session. "default" leaves the CLI's own choice alone. */
export interface AgentConfig {
  model: string;
  effort: string;
  permission: string;
}

interface Choice {
  value: string;
  name: string;
}

interface ProviderCatalog {
  models: Choice[];
  efforts: Choice[];
  permissions: Choice[];
  defaults: AgentConfig;
}

const EFFORTS: Choice[] = [
  { value: "low", name: "low" },
  { value: "medium", name: "medium" },
  { value: "high", name: "high" },
];

const CATALOGS = {
  claude: {
    models: [
      { value: "default", name: "Default" },
      { value: "claude-opus-5", name: "Opus 5" },
      { value: "claude-sonnet-5", name: "Sonnet 5" },
      { value: "claude-haiku-4-5-20251001", name: "Haiku 4.5" },
    ],
    // Claude Code carries no reasoning-effort switch; the selector stays hidden.
    efforts: [],
    permissions: [
      { value: "default", name: "ask" },
      { value: "acceptEdits", name: "accept edits" },
      { value: "bypassPermissions", name: "bypass" },
      { value: "plan", name: "plan" },
    ],
    defaults: { model: "default", effort: "", permission: "default" },
  },
  codex: {
    models: [
      { value: "default", name: "Default" },
      { value: "gpt-5-codex", name: "GPT-5 Codex" },
      { value: "gpt-5", name: "GPT-5" },
    ],
    efforts: EFFORTS,
    permissions: [
      { value: "on-request", name: "ask" },
      { value: "never", name: "bypass" },
    ],
    defaults: { model: "default", effort: "medium", permission: "on-request" },
  },
} satisfies Record<Provider, ProviderCatalog>;

export function defaultAgentConfig(provider: Provider): AgentConfig {
  return { ...CATALOGS[provider].defaults };
}

function select(
  id: string,
  name: string,
  category: "mode" | "model" | "thought_level",
  choices: Choice[],
  currentValue: string,
): SessionConfigOption {
  return {
    id,
    name,
    category,
    type: "select",
    currentValue,
    options: choices.map((choice) => ({ value: choice.value, name: choice.name })),
  };
}

export function agentConfigOptions(provider: Provider, config: AgentConfig): SessionConfigOption[] {
  const catalog = CATALOGS[provider];
  const options = [
    select(MODEL_CONFIG_ID, "Model", "model", catalog.models, config.model),
  ];
  if (catalog.efforts.length > 0) {
    options.push(select(EFFORT_CONFIG_ID, "Effort", "thought_level", catalog.efforts, config.effort));
  }
  options.push(select(PERMISSION_CONFIG_ID, "Permissions", "mode", catalog.permissions, config.permission));
  return options;
}

/** Applies one selector change, ignoring unknown ids and values. */
export function applyAgentConfig(
  provider: Provider,
  config: AgentConfig,
  configId: string,
  valueId: string,
): AgentConfig {
  const catalog = CATALOGS[provider];
  if (configId === MODEL_CONFIG_ID && catalog.models.some((choice) => choice.value === valueId)) {
    return { ...config, model: valueId };
  }
  if (configId === EFFORT_CONFIG_ID && catalog.efforts.some((choice) => choice.value === valueId)) {
    return { ...config, effort: valueId };
  }
  if (configId === PERMISSION_CONFIG_ID && catalog.permissions.some((choice) => choice.value === valueId)) {
    return { ...config, permission: valueId };
  }
  return config;
}
