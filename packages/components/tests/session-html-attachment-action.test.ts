import { describe, expect, it } from 'vitest';
import { resolveSessionHtmlAttachmentAction } from '../src/components/sessions/session-html-attachment-action';

describe('resolveSessionHtmlAttachmentAction', () => {
  it('opens proven local source paths in the file viewer', () => {
    expect(
      resolveSessionHtmlAttachmentAction({
        isLocalSession: true,
        sourcePath: 'artifacts/result.html',
      })
    ).toEqual({ kind: 'open-local-file', sourcePath: 'artifacts/result.html' });
    expect(
      resolveSessionHtmlAttachmentAction({
        isLocalSession: true,
        sourcePath: 'artifacts\\result.html',
      })
    ).toEqual({ kind: 'open-local-file', sourcePath: 'artifacts/result.html' });
  });

  it('opens an existing remote Browser connection without reconnecting', () => {
    expect(
      resolveSessionHtmlAttachmentAction({
        isLocalSession: false,
        sourcePath: 'artifacts/result.html',
        connectionStatus: 'active',
        candidateStatus: 'available',
      })
    ).toEqual({ kind: 'open-existing-browser' });
  });

  it('asks before connecting an agent-reported remote port', () => {
    expect(
      resolveSessionHtmlAttachmentAction({
        isLocalSession: false,
        candidateStatus: 'available',
      })
    ).toEqual({ kind: 'confirm-reported-port' });
  });

  it('keeps the attachment preview when provenance or a reported port is missing', () => {
    for (const sourcePath of [
      '',
      '/tmp/result.html',
      '../result.html',
      'C:\\tmp\\result.html',
      '..\\result.html',
      'artifacts\\..\\result.html',
      '\\tmp\\result.html',
      '\\\\server\\share\\result.html',
    ]) {
      expect(resolveSessionHtmlAttachmentAction({ isLocalSession: true, sourcePath })).toEqual({
        kind: 'fallback',
      });
    }
    expect(resolveSessionHtmlAttachmentAction({ isLocalSession: false })).toEqual({
      kind: 'fallback',
    });
  });
});
