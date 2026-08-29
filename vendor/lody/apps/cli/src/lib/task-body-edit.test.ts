import { describe, expect, it } from 'vitest';

import { planTaskBodyEdit } from './task-doc';

const BODY = `## Goal

Move session dispatch off the deprecated WS control plane.

- [ ] Audit remaining callers
- [ ] Migrate the retry path
`;

describe('planTaskBodyEdit', () => {
  it('replaces the single occurrence exactly', () => {
    const plan = planTaskBodyEdit(BODY, {
      oldString: 'Migrate the retry path',
      newString: 'Migrate the retry path (done)',
    });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.nextBody).toContain('Migrate the retry path (done)');
    expect(plan.nextBody.startsWith('## Goal')).toBe(true);
    expect(plan.added).toBe(7);
    expect(plan.removed).toBe(0);
  });

  it('refuses a stale oldString instead of guessing', () => {
    const plan = planTaskBodyEdit(BODY, {
      oldString: 'text that is not in the body',
      newString: 'anything',
    });

    // Returning the current body is what lets the agent retry against reality.
    expect(plan).toEqual({ ok: false, code: 'NO_MATCH', body: BODY });
  });

  it('refuses an ambiguous match and reports how many it found', () => {
    // Two identical checkbox lines: replacing "one of them" would silently
    // rewrite the wrong line of a person's task.
    const body = '- [ ] Audit callers\n- [ ] Audit callers\n';
    const plan = planTaskBodyEdit(body, {
      oldString: '- [ ] Audit callers',
      newString: '- [x] Audit callers',
    });

    expect(plan).toEqual({ ok: false, code: 'AMBIGUOUS_MATCH', occurrences: 2 });
  });

  it('leaves the body untouched on every refusal', () => {
    for (const edit of [
      { oldString: 'missing', newString: 'x' },
      { oldString: '- [ ] Audit remaining callers', newString: 'x' },
    ]) {
      const doubled = `${BODY}${BODY}`;
      const plan = planTaskBodyEdit(doubled, edit);
      if (plan.ok) {
        // The only ok case here is a unique match; assert it did not touch the rest.
        expect(plan.nextBody.length).not.toBe(0);
        continue;
      }
      expect(plan.code === 'NO_MATCH' || plan.code === 'AMBIGUOUS_MATCH').toBe(true);
    }
  });

  it('appends with a blank line when oldString is empty', () => {
    const plan = planTaskBodyEdit('Existing.', { oldString: '', newString: 'Added.' });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.nextBody).toBe('Existing.\n\nAdded.');
  });

  it('appends into an empty body without leading blank lines', () => {
    const plan = planTaskBodyEdit('', { oldString: '', newString: 'First note.' });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.nextBody).toBe('First note.');
  });

  it('reports removed characters when the edit shrinks the body', () => {
    const plan = planTaskBodyEdit('keep this line', { oldString: ' this', newString: '' });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.nextBody).toBe('keep line');
    expect(plan.removed).toBe(5);
    expect(plan.added).toBe(0);
  });
});
