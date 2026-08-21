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

const CATALOGS = {
  claude: {
    models: [
      { value: "default", name: "Default" },
      { value: "claude-fable-5", name: "Fable 5" },
      { value: "claude-opus-5", name: "Opus 5" },
      { value: "claude-sonnet-5", name: "Sonnet 5" },
      { value: "claude-haiku-4-5-20251001", name: "Haiku 4.5" },
    ],
    // The agent SDK's adaptive-thinking effort scale.
    efforts: [
      { value: "default", name: "default" },
      { value: "low", name: "low" },
      { value: "medium", name: "medium" },
      { value: "high", name: "high" },
      { value: "xhigh", name: "xhigh" },
      { value: "max", name: "max" },
    ],
    permissions: [
      { value: "default", name: "ask" },
      { value: "acceptEdits", name: "accept edits" },
      { value: "bypassPermissions", name: "bypass" },
      { value: "plan", name: "plan" },
    ],
    defaults: { model: "default", effort: "default", permission: "bypassPermissions" },
  },
  codex: {
    models: [
      { value: "default", name: "Default" },
      // Codex CLI user-selectable models; excluded on purpose: codex-auto-review (single-purpose review model), gpt-reserve (routing placeholder).
      { value: "gpt-5.6-sol", name: "GPT-5.6-Sol" },
      { value: "gpt-5.6-luna", name: "GPT-5.6-Luna" },
      { value: "gpt-5.6-terra", name: "GPT-5.6-Terra" },
      { value: "gpt-5.5", name: "GPT-5.5" },
      { value: "gpt-5.4", name: "GPT-5.4" },
      { value: "gpt-5.4-mini", name: "GPT-5.4-Mini" },
      { value: "gpt-5.3-codex-spark", name: "GPT-5.3-Codex-Spark" },
    ],
    // The cross-model superset; per-model narrowing lives in the schema catalog, and the codex harness rejects unsupported combos at runtime.
    efforts: [
      { value: "low", name: "low" },
      { value: "medium", name: "medium" },
      { value: "high", name: "high" },
      { value: "xhigh", name: "xhigh" },
      { value: "max", name: "max" },
      { value: "ultra", name: "ultra" },
    ],
    permissions: [
      { value: "on-request", name: "ask" },
      { value: "never", name: "bypass" },
    ],
    defaults: { model: "default", effort: "medium", permission: "never" },
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
