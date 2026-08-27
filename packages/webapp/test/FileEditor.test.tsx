import { act } from 'react';
import type { WebDAVClient } from 'webdav';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileEditor } from '../src/FileEditor.js';
import { render, settle } from './dom.js';

vi.mock('@uiw/react-codemirror', () => ({
  default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea
      aria-label="File contents"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

function detailedContents(content: string, etag: string) {
  return {
    data: new TextEncoder().encode(content),
    headers: { etag },
    status: 200,
  };
}

function editor(client: WebDAVClient, filePath: string) {
  return (
    <FileEditor
      active
      client={client}
      filePath={filePath}
      onDirtyChange={() => undefined}
      onSaved={() => undefined}
      onTreeRefresh={() => undefined}
      onUnauthorized={() => undefined}
    />
  );
}

function changeTextarea(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event('change', { bubbles: true }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FileEditor rename handling', () => {
  it('adopts the renamed file version without discarding the dirty buffer', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'test-save' });
    const customRequest = vi.fn(async (path: string) => new Response(null, {
      headers: { etag: path === 'notes.md' ? '"old"' : '"renamed"' },
    }));
    const moveFile = vi.fn().mockResolvedValue(undefined);
    const client = {
      stat: vi.fn().mockResolvedValue({ size: 5 }),
      getFileContents: vi.fn().mockResolvedValue(detailedContents('notes', '"old"')),
      customRequest,
      putFileContents: vi.fn().mockResolvedValue(true),
      moveFile,
      deleteFile: vi.fn().mockResolvedValue(undefined),
    } as unknown as WebDAVClient;
    const view = await render(editor(client, 'notes.md'));
    await settle();

    const textarea = view.container.querySelector<HTMLTextAreaElement>('textarea');
    expect(textarea).not.toBeNull();
    await act(async () => changeTextarea(textarea!, 'dirty notes'));

    await act(async () => view.root.render(editor(client, 'renamed.md')));
    await settle();
    expect(customRequest).toHaveBeenCalledWith('renamed.md', expect.objectContaining({ method: 'HEAD' }));
    expect(view.container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('dirty notes');

    const save = [...view.container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Save'));
    await act(async () => {
      save?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(moveFile).toHaveBeenCalledWith(
      '.renamed.md.blitz-test-save.tmp',
      'renamed.md',
      expect.objectContaining({ overwrite: true }),
    );
    expect(view.container.textContent).not.toContain('Changed on disk while you edited');
    await view.unmount();
  });

  it('saves when the proxy weakened the ETag it served for the open file', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'test-weak' });
    const moveFile = vi.fn().mockResolvedValue(undefined);
    const client = {
      stat: vi.fn().mockResolvedValue({ size: 5 }),
      // Cloudflare rewrites a strong ETag to weak on the compressed GET body;
      // the HEAD before save has no body and keeps the strong form.
      getFileContents: vi.fn().mockResolvedValue(detailedContents('notes', 'W/"v1"')),
      customRequest: vi.fn().mockResolvedValue(new Response(null, { headers: { etag: '"v1"' } })),
      putFileContents: vi.fn().mockResolvedValue(true),
      moveFile,
      deleteFile: vi.fn().mockResolvedValue(undefined),
    } as unknown as WebDAVClient;
    const view = await render(editor(client, 'notes.md'));
    await settle();
    const textarea = view.container.querySelector<HTMLTextAreaElement>('textarea');
    await act(async () => changeTextarea(textarea!, 'dirty notes'));
    const save = [...view.container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Save'));
    await act(async () => {
      save?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(moveFile).toHaveBeenCalledWith(
      '.notes.md.blitz-test-weak.tmp',
      'notes.md',
      expect.objectContaining({ overwrite: true }),
    );
    expect(view.container.textContent).not.toContain('Changed on disk while you edited');
    await view.unmount();
  });

  it('hides redundant file actions while the conflict actions are present', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'test-conflict' });
    const client = {
      stat: vi.fn().mockResolvedValue({ size: 5 }),
      getFileContents: vi.fn().mockResolvedValue(detailedContents('notes', '"old"')),
      customRequest: vi.fn().mockResolvedValue(new Response(null, { headers: { etag: '"changed"' } })),
      putFileContents: vi.fn().mockResolvedValue(true),
      moveFile: vi.fn().mockResolvedValue(undefined),
      deleteFile: vi.fn().mockResolvedValue(undefined),
    } as unknown as WebDAVClient;
    const view = await render(editor(client, 'notes.md'));
    await settle();
    const textarea = view.container.querySelector<HTMLTextAreaElement>('textarea');
    await act(async () => changeTextarea(textarea!, 'dirty notes'));
    const save = [...view.container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Save'));
    await act(async () => {
      save?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const header = view.container.querySelector('.file-editor-meta');
    expect(header?.classList.contains('file-editor-meta--conflict')).toBe(true);
    expect(header?.textContent).toContain('Overwrite');
    expect(header?.textContent).toContain('Reload');
    expect(header?.querySelector('.file-editor-copy')).not.toBeNull();
    expect(header?.querySelector('.file-editor-save')).not.toBeNull();
    await view.unmount();
  });
});
