// @vitest-environment jsdom

import { createStore } from 'jotai';
import { beforeEach, describe, expect, it } from 'vitest';

import { chatScopeAtom } from '../src/atoms/sidebar-state';

const CHAT_SCOPE_STORAGE_KEY = 'lody-sidebar-chat-scope';

function mountChatScopeStore() {
  const store = createStore();
  const unsubscribe = store.sub(chatScopeAtom, () => undefined);
  return { store, unsubscribe };
}

describe('chatScopeAtom', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('shows all workspace tasks when the user has not chosen a filter', () => {
    const { store, unsubscribe } = mountChatScopeStore();

    expect(store.get(chatScopeAtom)).toBe('team');
    expect(localStorage.getItem(CHAT_SCOPE_STORAGE_KEY)).toBeNull();

    unsubscribe();
  });

  it('preserves an explicitly saved My Tasks filter', () => {
    localStorage.setItem(CHAT_SCOPE_STORAGE_KEY, JSON.stringify('my'));

    const { store, unsubscribe } = mountChatScopeStore();

    expect(store.get(chatScopeAtom)).toBe('my');

    unsubscribe();
  });
});
