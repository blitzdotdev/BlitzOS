/** Stable ACP selector vocabulary backed by the composed DeepSeek Harness profile. */
export const DEEPSEEK_HARNESS_PERMISSION_MODES = [
  {
    id: 'read-only',
    name: 'Read-only',
    description: 'Read inside the workspace; protected writes require one-time approval.',
  },
  {
    id: 'workspace-write',
    name: 'Workspace write',
    description: 'Read and write inside the workspace; wider access requires one-time approval.',
  },
  {
    id: 'danger-full-access',
    name: 'Full access',
    description: 'Allow unrestricted file and command access without approval prompts.',
  },
] as const;

export const DEEPSEEK_HARNESS_MODELS = [
  {
    modelId: 'deepseek-v4-flash',
    name: 'DeepSeek-V4-Flash',
    description: 'Faster DeepSeek Harness coding model.',
    inputModalities: ['text'],
  },
  {
    modelId: 'deepseek-v4-pro',
    name: 'DeepSeek-V4-Pro',
    description: 'More capable DeepSeek Harness coding model.',
    inputModalities: ['text'],
  },
  {
    modelId: 'deepseek-v4-flash-vision-exp',
    name: 'DeepSeek-V4-Flash-Vision-Exp',
    description: 'Experimental multimodal DeepSeek model with image understanding.',
    inputModalities: ['text', 'image'],
  },
] as const;

export const DEEPSEEK_HARNESS_REASONING_OPTIONS = [
  { value: 'off', name: 'Off', description: 'Disable extended thinking' },
  { value: 'high', name: 'High', description: 'Use the standard reasoning budget' },
  { value: 'max', name: 'Max', description: 'Use the maximum reasoning budget' },
] as const;

/** Built-in agent compositions shipped by the official DeepSeek Harness CLI. */
export const DEEPSEEK_HARNESS_AGENT_PRESETS = [
  {
    value: 'standard',
    name: 'Standard mode',
    description:
      'Full coding agent with file editing, shell, search, skills, planning, goals, subagents, and workflows.',
  },
  {
    value: 'code',
    name: 'PTC mode',
    description:
      'Standard capabilities exposed through the Code Mode SDK for multi-step TypeScript programs.',
  },
  {
    value: 'minimal',
    name: 'Minimal mode',
    description: 'Two-tool coding agent with persistent bash and str_replace_editor.',
  },
  {
    value: 'cordis',
    name: 'Creator mode',
    description:
      'Standard capabilities plus runtime inspection, plugin experiments, and preset-authoring guidance.',
  },
] as const;
