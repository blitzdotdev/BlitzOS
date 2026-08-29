import { useCallback, useEffect, useRef, useSyncExternalStore, type RefObject } from 'react';
import { commands } from './registry';
import type { Command } from './types';

/**
 * Register a command for the lifetime of the calling component while `enabled` is true.
 *
 * The handler can change between renders without re-registering — the registered closure
 * always calls the latest one via a ref. Identity-defining fields (id, title, category,
 * keybindings, hidden, allowInTextInput) trigger re-registration.
 */
export function useCommand(command: Command, enabled = true): void {
  const runRef = useRef(command.run);
  const whenRef = useRef(command.when);

  // Keep refs current on every render so registered closures see the latest handler.
  runRef.current = command.run;
  whenRef.current = command.when;

  // Stringify keybindings for the dep array. They're a tiny config object; this avoids the
  // alternative of asking callers to memoize manually, which is easy to get wrong.
  const keybindingsKey = command.keybindings ? JSON.stringify(command.keybindings) : '';
  const hasWhen = Boolean(command.when);

  useEffect((): (() => void) | undefined => {
    if (!enabled) return undefined;
    return commands.register({
      id: command.id,
      title: command.title,
      titleKey: command.titleKey,
      category: command.category,
      keybindings: command.keybindings,
      hidden: command.hidden,
      allowInTextInput: command.allowInTextInput,
      run: () => runRef.current(),
      when: hasWhen ? () => whenRef.current?.() ?? true : undefined,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    command.id,
    command.title,
    command.titleKey,
    command.category,
    command.hidden,
    command.allowInTextInput,
    keybindingsKey,
    hasWhen,
    enabled,
    // run/when intentionally omitted — refs forward latest closures.
  ]);
}

/**
 * Claim keyboard input for a text-editing surface while focus is inside `ref`.
 *
 * Registers for the lifetime of the component and disposes on unmount, same as
 * `useCommand` — but a scope is not a command: it never reaches the palette,
 * the shortcut settings, or `execute()`. It exists so a rich text editor can
 * keep ⌘B for bold without every local shortcut having to be promoted to an
 * app-level command.
 *
 * With no `claims`, the scope takes every app shortcut except commands marked
 * `allowInTextInput` — the right default for an editor, which owns more keys
 * than it is practical to list. Pass `claims` to take only specific ones.
 */
export function useKeyScope(
  id: string,
  ref: RefObject<HTMLElement | null>,
  options: { claims?: string[]; enabled?: boolean } = {}
): void {
  const { claims, enabled = true } = options;
  // Same reason as the keybindings dep in `useCommand`: a tiny config array is
  // cheaper to stringify than to ask every caller to memoize correctly.
  const claimsKey = claims ? JSON.stringify(claims) : '';

  useEffect((): (() => void) | undefined => {
    if (!enabled) return undefined;
    return commands.registerKeyScope({
      id,
      element: () => ref.current,
      ...(claims ? { claims } : {}),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, ref, claimsKey, enabled]);
}

/** Subscribe to the live list of registered commands. */
export function useCommands(): readonly Command[] {
  const subscribe = useCallback((listener: () => void) => commands.subscribe(listener), []);
  const getSnapshot = useCallback(() => commands.list(), []);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
