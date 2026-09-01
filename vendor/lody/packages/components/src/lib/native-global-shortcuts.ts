import type {
  GlobalShortcutBinding,
  GlobalShortcutId,
  SetGlobalShortcutResult,
} from '@lody/shared';
import { getIpcServices } from './electron-ipc-client';

/**
 * Renderer-side bridge to the Electron main process's global-shortcut registry
 * (`getIpcServices()?.app`). Null-safe: on web / mobile / an older preload the
 * bridge is absent, so reads return `[]` and writes report a benign failure — callers
 * gate the whole feature behind `getRuntime() === 'electron'` anyway.
 */
export async function getGlobalShortcuts(): Promise<GlobalShortcutBinding[]> {
  if (typeof window === 'undefined') return [];
  if (!getIpcServices()) return [];
  try {
    return await getIpcServices()!.app.getGlobalShortcuts();
  } catch (error) {
    console.error('Failed to read global shortcuts', error);
    return [];
  }
}

/**
 * Suspend / resume OS global shortcuts while the renderer records a binding, so the combo
 * reaches the renderer (to be flagged as occupied) instead of firing the global action.
 * Null-safe no-op off Electron / on an older preload.
 */
export function setGlobalShortcutsSuspended(suspended: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    void getIpcServices()?.app.setGlobalShortcutsSuspended(suspended);
  } catch (error) {
    console.error('Failed to suspend global shortcuts', error);
  }
}

export async function setGlobalShortcut(
  id: GlobalShortcutId,
  binding: string | null
): Promise<SetGlobalShortcutResult> {
  if (typeof window === 'undefined') return { ok: false, error: 'invalid' };
  if (!getIpcServices()) return { ok: false, error: 'invalid' };
  try {
    return await getIpcServices()!.app.setGlobalShortcut({ id, binding });
  } catch (error) {
    console.error('Failed to set global shortcut', error);
    return { ok: false, error: 'invalid' };
  }
}
