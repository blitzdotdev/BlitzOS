export const ACP_EXTENSION_DSH_VERSION = '0.1.0';
export const DEEPSEEK_HARNESS_VERSION = '0.1.1-rc.2';
export const ACP_EXTENSION_DSH_PROFILE_REVISION = 'v5';
export const ACP_EXTENSION_DSH_SESSION_ROOT_ENV = 'ACP_EXTENSION_DSH_SESSION_ROOT';
export const ACP_EXTENSION_DSH_QUERY_PATH_ENV = 'ACP_EXTENSION_DSH_QUERY_PATH';
export const DEEPSEEK_HARNESS_DEFAULT_SESSION_COMPRESSION = 'zstd';
export const ACP_EXTENSION_DSH_CAPABILITY_SOURCE_VERSION = `acp-extension-dsh@${ACP_EXTENSION_DSH_VERSION}:dsh@${DEEPSEEK_HARNESS_VERSION}:profile-${ACP_EXTENSION_DSH_PROFILE_REVISION}`;
// Keep the ACP entry package first. Hosts use its binary to launch the explicit
// composition below. The official all-in-one product CLI is deliberately not
// installed: this ACP host owns a smaller immutable composition and must not
// inherit product UI or telemetry packages. Every package used by the host plane
// or one of the four shipped Agent presets is pinned to the same Harness release.
export const DEEPSEEK_HARNESS_NPX_PACKAGES = [
    '@deepseek-ai/dsh-acp-demo',
    '@deepseek-ai/dsh-agent-spine-demo',
    '@deepseek-ai/dsh-session-persistence-jsonl',
    '@deepseek-ai/dsh-session-checkpoint-policy',
    '@deepseek-ai/dsh-session-query-sqlite',
    '@deepseek-ai/dsh-attachment-local',
    '@deepseek-ai/dsh-llm-deepseek',
    '@deepseek-ai/dsh-sandbox-local',
    '@deepseek-ai/dsh-sandbox-policy',
    '@deepseek-ai/dsh-subprocess-local',
    '@deepseek-ai/dsh-bash-sandbox',
    '@deepseek-ai/dsh-pwsh-sandbox',
    '@deepseek-ai/dsh-user-approval',
    '@deepseek-ai/dsh-permission-presets',
    '@deepseek-ai/dsh-token-meter',
    '@deepseek-ai/dsh-fs-sandbox',
    '@deepseek-ai/dsh-fs-observation-policy',
    '@deepseek-ai/dsh-shell-env',
    '@deepseek-ai/dsh-commands',
    '@deepseek-ai/dsh-skill',
    '@deepseek-ai/dsh-goal',
    '@deepseek-ai/dsh-goal-round-driver',
    '@deepseek-ai/dsh-user-questions',
    '@deepseek-ai/dsh-session-projection',
    '@deepseek-ai/dsh-subagent',
    '@deepseek-ai/dsh-subagent-spawn-in-process',
    '@deepseek-ai/dsh-subagent-fork-in-process',
    '@deepseek-ai/dsh-tool-subagent-report',
    '@deepseek-ai/dsh-web',
    '@deepseek-ai/dsh-web-search-deepseek',
    '@deepseek-ai/dsh-code-runtime-worker-thread',
    '@deepseek-ai/dsh-cordis-host-runner',
    '@deepseek-ai/dsh-agent-presets',
    '@deepseek-ai/dsh-mcp-client',
    '@deepseek-ai/dsh-persona',
    '@deepseek-ai/dsh-agent-instructions',
    '@deepseek-ai/dsh-tool-bash',
    '@deepseek-ai/dsh-tool-pwsh',
    '@deepseek-ai/dsh-tool-fs',
    '@deepseek-ai/dsh-tool-fs-search',
    '@deepseek-ai/dsh-tool-jobs',
    '@deepseek-ai/dsh-tool-goal',
    '@deepseek-ai/dsh-plan-mode',
    '@deepseek-ai/dsh-compaction-basic',
    '@deepseek-ai/dsh-command-compact',
    '@deepseek-ai/dsh-compaction-tool-result-pruner',
    '@deepseek-ai/dsh-tool-subagent-control',
    '@deepseek-ai/dsh-tool-subagent',
    '@deepseek-ai/dsh-workflow-worker-thread',
    '@deepseek-ai/dsh-tool-workflow',
    '@deepseek-ai/dsh-tool-ralph',
    '@deepseek-ai/dsh-tool-ask-user',
    '@deepseek-ai/dsh-tool-todo',
    '@deepseek-ai/dsh-tool-web',
    '@deepseek-ai/dsh-skill-filesystem',
    '@deepseek-ai/dsh-tool-skill',
    '@deepseek-ai/dsh-agent-tool-presentation',
    '@deepseek-ai/dsh-tool-cordis',
    '@deepseek-ai/dsh-terminal',
    '@deepseek-ai/dsh-terminal-bash',
    '@deepseek-ai/dsh-tool-bash-persistent',
    '@deepseek-ai/dsh-tool-pwsh-persistent',
    '@deepseek-ai/dsh-fs-local',
    '@deepseek-ai/dsh-tool-str-replace-editor',
    // Pin the complete transitive DSH dependency and peer closure too. Harness
    // packages publish caret ranges, so leaving one implicit lets npm mix a later
    // release candidate into this otherwise immutable composition when published.
    '@deepseek-ai/dsh-acp',
    '@deepseek-ai/dsh-agent',
    '@deepseek-ai/dsh-agent-loop',
    '@deepseek-ai/dsh-anonymous-user-id',
    '@deepseek-ai/dsh-app-boot',
    '@deepseek-ai/dsh-atomic-write',
    '@deepseek-ai/dsh-attachment',
    '@deepseek-ai/dsh-bash-local',
    '@deepseek-ai/dsh-brand',
    '@deepseek-ai/dsh-code-runtime',
    '@deepseek-ai/dsh-compaction',
    '@deepseek-ai/dsh-credentials',
    '@deepseek-ai/dsh-fs',
    '@deepseek-ai/dsh-home-paths',
    '@deepseek-ai/dsh-invariants',
    '@deepseek-ai/dsh-jobs',
    '@deepseek-ai/dsh-jobs-local',
    '@deepseek-ai/dsh-launch-environment',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-llm-retry',
    '@deepseek-ai/dsh-output-retention',
    '@deepseek-ai/dsh-pwsh-local',
    '@deepseek-ai/dsh-sandbox',
    '@deepseek-ai/dsh-sandbox-windows-acl',
    '@deepseek-ai/dsh-scope',
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-session-persistence',
    '@deepseek-ai/dsh-session-projection-cache',
    '@deepseek-ai/dsh-session-query',
    '@deepseek-ai/dsh-session-title',
    '@deepseek-ai/dsh-settings',
    '@deepseek-ai/dsh-shell',
    '@deepseek-ai/dsh-spill',
    '@deepseek-ai/dsh-storage',
    '@deepseek-ai/dsh-storage-domain',
    '@deepseek-ai/dsh-subagent-in-process-driver',
    '@deepseek-ai/dsh-subprocess',
    '@deepseek-ai/dsh-system-prompt',
    '@deepseek-ai/dsh-timeout',
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-typert-protocol',
    '@deepseek-ai/dsh-workflow',
];
/**
 * Build the immutable ACP host composition consumed by dsh-acp-demo.
 *
 * Registries, persistence, policy, and execution backends live on the host
 * plane. Model-facing tools and prompt sections are mounted per Agent from the
 * official preset files rooted at `presetRoot`.
 */
export function createDeepSeekHarnessCordisConfig(adapterPath, presetRoot, sessionCompression = DEEPSEEK_HARNESS_DEFAULT_SESSION_COMPRESSION) {
    return `# Generated for acp-extension-dsh. API credentials stay in the host environment.
- id: agent-spine
  name: '@deepseek-ai/dsh-agent-spine-demo'
  config:
    workspaceContext: false
    skills:
      enabled: false
    toolBash: false
    toolJobs: false
    goals: false
    persona: ''

- id: session-persistence
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: !!js process.env.${ACP_EXTENSION_DSH_SESSION_ROOT_ENV}
    compression: ${sessionCompression}

- id: session-checkpoint
  name: '@deepseek-ai/dsh-session-checkpoint-policy'

- id: session-query
  name: '@deepseek-ai/dsh-session-query-sqlite'
  config:
    path: !!js process.env.${ACP_EXTENSION_DSH_QUERY_PATH_ENV}
    openAt: never

- id: attachment-local
  name: '@deepseek-ai/dsh-attachment-local'

- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    thinking: enabled
    reasoningEffort: max

- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'

- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: workspace-write
    workspaceRoot: !!js process.cwd()

- id: subprocess
  name: '@deepseek-ai/dsh-subprocess-local'

- id: bash
  name: '@deepseek-ai/dsh-bash-sandbox'
  disabled: !!js process.platform === 'win32'
  config:
    timeoutMs: 60000

- id: pwsh
  name: '@deepseek-ai/dsh-pwsh-sandbox'
  disabled: !!js process.platform !== 'win32'

- id: approval
  name: '@deepseek-ai/dsh-user-approval'
  config:
    policy: ask

- id: permission-presets
  name: '@deepseek-ai/dsh-permission-presets'
  config:
    defaultPreset: workspace-write
    presets:
      read-only:
        sandbox: read-only
        approval: ask
        name: Read-only
        description: Read inside the workspace; protected writes require one-time approval.
      workspace-write:
        sandbox: workspace-write
        approval: ask
        name: Workspace write
        description: Read and write inside the workspace; wider access requires one-time approval.
      danger-full-access:
        sandbox: danger-full-access
        approval: never
        name: Full access
        description: Allow unrestricted file and command access without approval prompts.

# Host-plane services shared by every per-session preset.
- id: shell-env
  name: '@deepseek-ai/dsh-shell-env'

- id: commands
  name: '@deepseek-ai/dsh-commands'

- id: fs-sandbox
  name: '@deepseek-ai/dsh-fs-sandbox'
  config:
    cwd: !!js process.cwd()

- id: fs-observation-policy
  name: '@deepseek-ai/dsh-fs-observation-policy'

- id: skill
  name: '@deepseek-ai/dsh-skill'

- id: goal
  name: '@deepseek-ai/dsh-goal'

- id: goal-round-driver
  name: '@deepseek-ai/dsh-goal-round-driver'

- id: user-questions
  name: '@deepseek-ai/dsh-user-questions'

- id: session-projection
  name: '@deepseek-ai/dsh-session-projection'

- id: subagent
  name: '@deepseek-ai/dsh-subagent'

- id: subagent-spawn-in-process
  name: '@deepseek-ai/dsh-subagent-spawn-in-process'
  config:
    providerName: spawn

- id: subagent-fork-in-process
  name: '@deepseek-ai/dsh-subagent-fork-in-process'
  config:
    providerName: fork

- id: tool-subagent-report
  name: '@deepseek-ai/dsh-tool-subagent-report'

- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: deepseek-official

- id: web-search-deepseek
  name: '@deepseek-ai/dsh-web-search-deepseek'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY

- id: code-runtime
  name: '@deepseek-ai/dsh-code-runtime-worker-thread'

- id: cordis-host-runner
  name: '@deepseek-ai/dsh-cordis-host-runner'

- id: token-meter
  name: '@deepseek-ai/dsh-token-meter'

# The shipped root supplies the four official modes. AgentPresets also appends
# $DSH_HOME/.agent-presets so user-authored DSH compositions remain available.
- id: agent-presets
  name: '@deepseek-ai/dsh-agent-presets'
  config:
    default: standard
    roots:
      - path: ${JSON.stringify(presetRoot)}
        trust: system

- id: acp-agent
  name: ${JSON.stringify(adapterPath)}
  config:
    provider: deepseek-official
    model: deepseek-v4-pro
    reasoningEffort: max
`;
}
//# sourceMappingURL=profile.js.map