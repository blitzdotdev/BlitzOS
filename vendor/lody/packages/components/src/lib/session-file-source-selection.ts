export type SessionFileSurfaceSource = 'provider' | 'provider-pending' | 'local' | 'unavailable';

export type SessionFileSurfaceSourceInput = {
  readonly hasFileProvider: boolean;
  readonly fileProviderPending?: boolean;
  readonly hasLocalFileSource: boolean;
  readonly allowLocalFileSource?: boolean;
};

/**
 * Keep Code Collab as the primary file source while its provider is ready or
 * pending. Callers may allow a same-machine Electron source after provider
 * resolution reaches a terminal state.
 */
export function chooseSessionFileSurfaceSource(
  input: SessionFileSurfaceSourceInput
): SessionFileSurfaceSource {
  if (input.hasFileProvider) {
    return 'provider';
  }
  if (input.fileProviderPending === true) {
    return 'provider-pending';
  }
  if (input.hasLocalFileSource && input.allowLocalFileSource === true) {
    return 'local';
  }
  return 'unavailable';
}
