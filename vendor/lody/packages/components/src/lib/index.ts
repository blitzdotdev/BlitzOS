export * from './utils';
export * from './auth';
export * from './app-location';
export * from './code-collab-session-file-provider';
export * from './file-workspace-provider';
export * from './session-file-provider-selection';
export * from './session-file-provider-view-model';
export * from './session-file-provider';
export * from './project-skills-cache';
export * from './local-project-skills-provider';

function resolveApiBaseUrl(): string {
  // `import.meta.env` is a Vite-only global — it's `undefined` under other bundlers
  // (e.g. the Next.js marketing preview that reuses these components), so read it
  // defensively rather than crashing at module-evaluation time.
  const importMetaEnv = (import.meta as { env?: Record<string, string | undefined> }).env;
  const envValue = importMetaEnv?.VITE_SERVER_URL;
  if (envValue) return envValue;

  if (typeof window === 'undefined') {
    return 'https://lody.ai';
  }

  // Web: default to localhost agent in local dev; otherwise assume same-origin deployments.
  const hostname = window.location.hostname;
  const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  if (isLocalhost) {
    return 'http://localhost:8787';
  }
  return window.location.origin;
}

export const API_BASE_URL = resolveApiBaseUrl();
export const buildAgentPrompt = (prompt: string, agentPrompt = '') =>
  [agentPrompt, prompt].filter((part) => part?.trim()).join('\n\n');
