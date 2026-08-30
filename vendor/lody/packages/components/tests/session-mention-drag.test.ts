// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import {
  SESSION_MENTION_DRAG_TYPE,
  SESSION_MENTION_DROP_LAYER_ATTR,
  armSessionMentionDrag,
  clearSessionMentionDrag,
  getInFlightSessionMentionDragId,
  hasAcceptableSessionMentionTransfer,
  isPointOverSessionMentionDropLayer,
  readSessionMentionDragSessionId,
  startSessionMentionDrag,
} from '../src/lib/session-mention-drag';
import { createSessionMentionTransfer } from './helpers/session-mention-transfer';

describe('session mention drag transfer', () => {
  afterEach(() => {
    clearSessionMentionDrag();
  });

  it('carries the id in the payload and in a type name', () => {
    const transfer = createSessionMentionTransfer();
    startSessionMentionDrag({ dataTransfer: transfer }, { sessionId: 'sess_AbC', title: 'Fix CI' });

    expect(transfer.effectAllowed).toBe('copy');
    expect(transfer.types).toContain(SESSION_MENTION_DRAG_TYPE);
    // The exact-cased id only survives in the payload; the type name is folded.
    expect(readSessionMentionDragSessionId(transfer)).toBe('sess_AbC');
    expect(transfer.getData('text/plain')).toBe('Fix CI');
  });

  it('falls back to the id when the session has no title', () => {
    const transfer = createSessionMentionTransfer();
    startSessionMentionDrag({ dataTransfer: transfer }, { sessionId: 'sess_1', title: '   ' });
    expect(transfer.getData('text/plain')).toBe('sess_1');
  });

  it('ignores drags that are not ours', () => {
    const files = { types: ['Files'] };
    expect(hasAcceptableSessionMentionTransfer(files)).toBe(false);
    expect(hasAcceptableSessionMentionTransfer(null)).toBe(false);
  });

  it('refuses the conversation the surface already is, before the drop', () => {
    const transfer = createSessionMentionTransfer();
    startSessionMentionDrag({ dataTransfer: transfer }, { sessionId: 'sess_AbC' });

    // Case-insensitive: the type name the check reads has been lowercased.
    expect(hasAcceptableSessionMentionTransfer(transfer, { excludeSessionId: 'sess_AbC' })).toBe(
      false
    );
    expect(hasAcceptableSessionMentionTransfer(transfer, { excludeSessionId: 'sess_other' })).toBe(
      true
    );
    expect(hasAcceptableSessionMentionTransfer(transfer)).toBe(true);
  });

  it('reads nothing from a transfer without our payload', () => {
    expect(readSessionMentionDragSessionId(createSessionMentionTransfer())).toBeNull();
  });

  it('arms the in-flight store as soon as a sidebar drag starts', () => {
    expect(getInFlightSessionMentionDragId()).toBeNull();
    const transfer = createSessionMentionTransfer();
    startSessionMentionDrag({ dataTransfer: transfer }, { sessionId: 'sess_AbC' });

    expect(getInFlightSessionMentionDragId()).toBe('sess_AbC');
  });

  it('clears the in-flight store on dragend', () => {
    startSessionMentionDrag(
      { dataTransfer: createSessionMentionTransfer() },
      { sessionId: 'sess_1' }
    );
    expect(getInFlightSessionMentionDragId()).toBe('sess_1');

    if (typeof window === 'undefined') {
      clearSessionMentionDrag();
    } else {
      window.dispatchEvent(new Event('dragend'));
    }
    expect(getInFlightSessionMentionDragId()).toBeNull();
  });

  it('arms a pointer drag without an HTML5 transfer', () => {
    armSessionMentionDrag('sess_tab');
    expect(getInFlightSessionMentionDragId()).toBe('sess_tab');
    clearSessionMentionDrag();
    expect(getInFlightSessionMentionDragId()).toBeNull();
  });

  it('detects a point over the conversation drop layer', () => {
    const layer = document.createElement('div');
    layer.setAttribute(SESSION_MENTION_DROP_LAYER_ATTR, '');
    const inner = document.createElement('span');
    layer.appendChild(inner);
    document.body.appendChild(layer);
    const original = document.elementFromPoint?.bind(document);
    document.elementFromPoint = () => inner;
    try {
      expect(isPointOverSessionMentionDropLayer(10, 10)).toBe(true);
      document.elementFromPoint = () => document.body;
      expect(isPointOverSessionMentionDropLayer(10, 10)).toBe(false);
    } finally {
      if (original) document.elementFromPoint = original;
      else Reflect.deleteProperty(document, 'elementFromPoint');
      layer.remove();
    }
  });
});
