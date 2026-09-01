import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { commands } from '../src/lib/commands/registry';

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

class FakeKeyboardTarget {
  private listeners = new Set<(e: KeyboardEvent) => void>();
  addEventListener(_type: string, listener: (e: KeyboardEvent) => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: string, listener: (e: KeyboardEvent) => void): void {
    this.listeners.delete(listener);
  }
  dispatch(event: KeyboardEvent): void {
    for (const l of this.listeners) l(event);
  }
}

function ev(init: Partial<KeyboardEventInit> & { key: string }): KeyboardEvent {
  let prevented = false;
  return {
    key: init.key,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
    get defaultPrevented() {
      return prevented;
    },
    preventDefault() {
      prevented = true;
    },
  } as unknown as KeyboardEvent;
}

let target: FakeKeyboardTarget;
let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal('localStorage', storage);
  target = new FakeKeyboardTarget();
  commands.attach(target as unknown as HTMLElement);
});

afterEach(() => {
  commands.resetAllUserKeybindings();
  for (const cmd of commands.list()) commands.unregister(cmd.id);
  commands.detach();
  vi.unstubAllGlobals();
});

describe('user-bindings overrides', () => {
  it('override replaces the default binding', () => {
    const run = vi.fn();
    commands.register({
      id: 'foo',
      title: 'Foo',
      keybindings: ['$mod+b'],
      run,
    });
    expect(commands.getKeybindingsFor('foo')).toEqual(['$mod+b']);

    commands.setUserKeybindings('foo', ['$mod+j']);
    expect(commands.getKeybindingsFor('foo')).toEqual(['$mod+j']);
    expect(commands.hasUserOverride('foo')).toBe(true);

    // Old binding no longer fires
    target.dispatch(ev({ key: 'b', ctrlKey: true }));
    expect(run).not.toHaveBeenCalled();
    // New binding fires
    target.dispatch(ev({ key: 'j', ctrlKey: true }));
    expect(run).toHaveBeenCalledOnce();
  });

  it('empty array unbinds the command entirely', () => {
    const run = vi.fn();
    commands.register({
      id: 'foo',
      title: 'Foo',
      keybindings: ['$mod+b'],
      run,
    });
    commands.setUserKeybindings('foo', []);
    expect(commands.getKeybindingsFor('foo')).toEqual([]);
    target.dispatch(ev({ key: 'b', ctrlKey: true }));
    expect(run).not.toHaveBeenCalled();
  });

  it('null override restores defaults', () => {
    const run = vi.fn();
    commands.register({ id: 'foo', title: 'Foo', keybindings: ['$mod+b'], run });
    commands.setUserKeybindings('foo', ['$mod+j']);
    commands.setUserKeybindings('foo', null);
    expect(commands.hasUserOverride('foo')).toBe(false);
    expect(commands.getKeybindingsFor('foo')).toEqual(['$mod+b']);
  });

  it('overrides persist across registry attaches via localStorage', () => {
    commands.register({ id: 'foo', title: 'Foo', keybindings: ['$mod+b'], run: () => {} });
    commands.setUserKeybindings('foo', ['$mod+j']);
    expect(storage.getItem('lody.commandOverrides.v1')).toContain('$mod+j');

    // Simulate a reload: detach + re-attach. The override should reload.
    commands.unregister('foo');
    commands.detach();
    // New target; same localStorage.
    const target2 = new FakeKeyboardTarget();
    commands.attach(target2 as unknown as HTMLElement);
    commands.register({ id: 'foo', title: 'Foo', keybindings: ['$mod+b'], run: () => {} });
    expect(commands.getKeybindingsFor('foo')).toEqual(['$mod+j']);
  });

  it('resetAllUserKeybindings clears every override', () => {
    commands.register({ id: 'a', title: 'A', keybindings: ['$mod+a'], run: () => {} });
    commands.register({ id: 'b', title: 'B', keybindings: ['$mod+b'], run: () => {} });
    commands.setUserKeybindings('a', ['$mod+x']);
    commands.setUserKeybindings('b', ['$mod+y']);
    commands.resetAllUserKeybindings();
    expect(commands.hasUserOverride('a')).toBe(false);
    expect(commands.hasUserOverride('b')).toBe(false);
    expect(commands.getKeybindingsFor('a')).toEqual(['$mod+a']);
    expect(commands.getKeybindingsFor('b')).toEqual(['$mod+b']);
  });

  it('getDefaultKeybindingsFor ignores overrides', () => {
    commands.register({ id: 'foo', title: 'Foo', keybindings: ['$mod+b'], run: () => {} });
    commands.setUserKeybindings('foo', ['$mod+j']);
    expect(commands.getDefaultKeybindingsFor('foo')).toEqual(['$mod+b']);
  });

  it('findCommandBoundTo locates collision targets', () => {
    commands.register({ id: 'a', title: 'A', keybindings: ['$mod+k'], run: () => {} });
    commands.register({ id: 'b', title: 'B', keybindings: ['$mod+x'], run: () => {} });
    expect(commands.findCommandBoundTo('$mod+k')).toBe('a');
    expect(commands.findCommandBoundTo('$mod+k', 'a')).toBeNull();
    expect(commands.findCommandBoundTo('$mod+z')).toBeNull();
  });
});
