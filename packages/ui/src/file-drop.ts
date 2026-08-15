import { shellQuotedPath } from './files';

// Drop a screenshot on a tab, get its path in the TUI. The upload reuses the
// dufs WebDAV server the workspace already runs (:7446 behind /files*), and the
// paste reuses the terminal's existing submit event. No new protocol.

export type DropUploader = {
  putFileContents(path: string, data: ArrayBuffer): Promise<unknown>;
  exists(path: string): Promise<boolean>;
};

export type DroppedFile = {
  name: string;
  arrayBuffer(): Promise<ArrayBuffer>;
};

// dufs writes into the workspace home, and the home is the volume, so a name
// collision would silently replace a file the user still wants. Suffix instead:
// "shot.png" -> "shot-1.png". The stem/extension split keeps the extension last
// so the TUI still recognises the type.
export function suffixedName(name: string, attempt: number): string {
  if (attempt === 0) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  return `${stem}-${attempt}${extension}`;
}

// A dropped name is attacker-controlled in the sense that it comes from the
// filesystem, not from us: strip directory separators so a crafted name cannot
// escape the home directory, and drop leading dots so it cannot land as a
// hidden config file.
export function safeDropName(name: string): string {
  const base = name.split(/[\\/]/u).pop() ?? '';
  const cleaned = base.replace(/^\.+/u, '').trim();
  return cleaned || 'upload';
}

export async function uniqueDropName(
  uploader: DropUploader,
  name: string,
  limit = 50,
): Promise<string> {
  const safe = safeDropName(name);
  for (let attempt = 0; attempt < limit; attempt += 1) {
    const candidate = suffixedName(safe, attempt);
    if (!(await uploader.exists(candidate))) return candidate;
  }
  throw new Error(`could not find a free name for ${safe}`);
}

export type DropResult = {
  uploaded: string[];
  failed: Array<{ name: string; error: string }>;
};

export async function uploadDroppedFiles(
  uploader: DropUploader,
  files: readonly DroppedFile[],
): Promise<DropResult> {
  const uploaded: string[] = [];
  const failed: DropResult['failed'] = [];
  // Sequential: the paste order must match the drop order, and a workspace box
  // is a small VM — a parallel burst of screenshots is not worth the risk.
  for (const file of files) {
    try {
      const name = await uniqueDropName(uploader, file.name);
      await uploader.putFileContents(name, await file.arrayBuffer());
      uploaded.push(name);
    } catch (error) {
      failed.push({
        name: file.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { uploaded, failed };
}

// What actually reaches the TUI. Trailing space so the user can keep typing,
// and the paths are shell-quoted because screenshot names routinely carry
// spaces ("Screenshot 2026-08-07 at 00.14.22.png").
export function dropPasteText(names: readonly string[]): string {
  if (names.length === 0) return '';
  return `${names.map(shellQuotedPath).join(' ')} `;
}
