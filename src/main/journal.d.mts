export function ls(p?: string): Array<{ name: string; type: 'file' | 'dir'; size: number }>
export function cat(p: string): string
export function write(p: string, content: string): { ok: boolean; path: string }
export function append(p: string, text: string): { ok: boolean; path: string }
export function mkdir(p: string): { ok: boolean; path: string }
export function rm(p: string): { ok: boolean; path: string }
export function mv(from: string, to: string): { ok: boolean }
export function grep(pattern: string, p?: string): Array<{ path: string; line: number; text: string }>
export function fsOp(op: string, args?: Record<string, unknown>): unknown
export function shFs(cmd: string): unknown
