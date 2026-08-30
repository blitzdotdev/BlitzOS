// Preview shim for `@/lib/session-file-download`.
// The real module transitively imports the `@/lib` barrel, whose top-level
// `resolveApiBaseUrl()` reads Vite's `import.meta.env.VITE_SERVER_URL` at module
// load — undefined (and a hard crash) in the Next marketing build. The ai-gui
// renderer only calls these on an actual file download/preview, which the mock
// conversation never triggers, so no-ops keep the renderer importable.

export const downloadSessionFile = async (): Promise<void> => {
  return undefined;
};

export const fetchSessionFilePreview = async (): Promise<never> => {
  throw new Error('session file preview is disabled in the marketing preview');
};
