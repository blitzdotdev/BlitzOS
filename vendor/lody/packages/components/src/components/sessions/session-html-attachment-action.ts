import { isSessionFileSourcePath } from '@lody/shared';

export type SessionHtmlAttachmentAction =
  | { readonly kind: 'open-local-file'; readonly sourcePath: string }
  | { readonly kind: 'open-existing-browser' }
  | { readonly kind: 'confirm-reported-port' }
  | { readonly kind: 'fallback' };

/**
 * Resolve an HTML attachment click without guessing a file path or port.
 * Historical blocks without source provenance keep the ordinary attachment
 * preview, and remote sessions only offer Browser when the agent has already
 * reported a target or established a connection.
 */
export function resolveSessionHtmlAttachmentAction(args: {
  readonly isLocalSession: boolean;
  readonly sourcePath?: string;
  readonly connectionStatus?: string;
  readonly candidateStatus?: string;
}): SessionHtmlAttachmentAction {
  const sourcePath = args.sourcePath?.replace(/\\/g, '/');
  if (args.isLocalSession) {
    return sourcePath && isSessionFileSourcePath(sourcePath)
      ? { kind: 'open-local-file', sourcePath }
      : { kind: 'fallback' };
  }
  if (args.connectionStatus === 'active') {
    return { kind: 'open-existing-browser' };
  }
  if (args.candidateStatus === 'available') {
    return { kind: 'confirm-reported-port' };
  }
  return { kind: 'fallback' };
}
