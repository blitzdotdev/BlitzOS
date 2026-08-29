import { describe, expect, it } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import { Mirror } from 'loro-mirror';

import { taskDocSchema } from '../src/task-schema';

/**
 * The task body is committed as a whole string. These tests check that the
 * Mirror turns that into minimal LoroText operations, because the entire reason
 * the body lives in a CRDT is that two people editing different parts must both
 * survive. A whole-text replace would merge as last-writer-wins and silently
 * drop one side's paragraph.
 */
const openTask = (doc: LoroDoc) =>
  new Mirror({
    doc,
    schema: taskDocSchema,
    initialState: {
      meta: {
        taskId: 'task-1',
        title: 'Shared body',
        status: 'backlog',
        ownerId: 'user-1',
        order: '1',
        agent: undefined,
        projects: undefined,
        lastRunConfig: undefined,
        createdAt: 1,
        updatedAt: 1,
        createdBy: undefined,
      },
      body: '',
      links: [],
      timeline: [],
    },
  });

const setBody = (mirror: ReturnType<typeof openTask>, body: string): void => {
  mirror.setState((draft: unknown) => {
    (draft as { body: string }).body = body;
  });
};

const readBody = (mirror: ReturnType<typeof openTask>): string =>
  (mirror.getState() as unknown as { body: string }).body;

const pushComment = (mirror: ReturnType<typeof openTask>, id: string, body: string): void => {
  mirror.setState((draft: unknown) => {
    (draft as { timeline: unknown[] }).timeline.push({
      id,
      kind: 'comment',
      actorKind: 'human',
      actorId: id,
      createdAt: 1,
      body,
    });
  });
};

const pushSessionLink = (mirror: ReturnType<typeof openTask>, id: string): void => {
  mirror.setState((draft: unknown) => {
    (draft as { links: unknown[] }).links.push({
      id,
      kind: 'session',
      actorKind: 'human',
      linkedAt: 1,
      sessionId: `session-${id}`,
      origin: 'run',
    });
  });
};

const readIds = (mirror: ReturnType<typeof openTask>, field: 'timeline' | 'links'): string[] =>
  ((mirror.getState() as unknown as Record<string, { id: string }[]>)[field] ?? []).map(
    (entry) => entry.id
  );

describe('task list CRDT merge', () => {
  it('keeps both comments when two people comment at the same time', () => {
    // Losing a comment loses user-authored content, so concurrent appends to the
    // timeline must both survive rather than one overwriting the other.
    const docA = new LoroDoc();
    const mirrorA = openTask(docA);
    pushComment(mirrorA, 'c0', 'Existing note.');

    const docB = new LoroDoc();
    docB.import(docA.export({ mode: 'update' }));
    const mirrorB = openTask(docB);

    pushComment(mirrorA, 'from-a', 'A comments.');
    pushComment(mirrorB, 'from-b', 'B comments.');

    docA.import(docB.export({ mode: 'update' }));
    docB.import(docA.export({ mode: 'update' }));

    const ids = readIds(mirrorA, 'timeline');
    expect(ids).toContain('from-a');
    expect(ids).toContain('from-b');
    expect(ids).toHaveLength(3);
    expect(readIds(mirrorB, 'timeline')).toEqual(ids);

    mirrorA.dispose();
    mirrorB.dispose();
  });

  it('keeps both links when the app and the CLI associate work concurrently', () => {
    // This race is real: Run links a session from the app while an agent links a
    // PR from the CLI. Dropping either loses the association silently.
    const docA = new LoroDoc();
    const mirrorA = openTask(docA);
    const docB = new LoroDoc();
    docB.import(docA.export({ mode: 'update' }));
    const mirrorB = openTask(docB);

    pushSessionLink(mirrorA, 'app');
    pushSessionLink(mirrorB, 'cli');

    docA.import(docB.export({ mode: 'update' }));
    docB.import(docA.export({ mode: 'update' }));

    const ids = readIds(mirrorA, 'links');
    expect(ids).toContain('app');
    expect(ids).toContain('cli');
    expect(readIds(mirrorB, 'links')).toEqual(ids);

    mirrorA.dispose();
    mirrorB.dispose();
  });
});

describe('task body CRDT merge', () => {
  it('keeps both sides when two clients edit different paragraphs', () => {
    const docA = new LoroDoc();
    const mirrorA = openTask(docA);
    setBody(mirrorA, 'First paragraph.\n\nSecond paragraph.\n');

    // B starts from A's state, the way a second client would after syncing.
    const docB = new LoroDoc();
    docB.import(docA.export({ mode: 'update' }));
    const mirrorB = openTask(docB);
    expect(readBody(mirrorB)).toBe('First paragraph.\n\nSecond paragraph.\n');

    // Concurrent edits: A rewrites the first paragraph, B the second.
    setBody(mirrorA, 'First paragraph, revised by A.\n\nSecond paragraph.\n');
    setBody(mirrorB, 'First paragraph.\n\nSecond paragraph, revised by B.\n');

    docA.import(docB.export({ mode: 'update' }));
    docB.import(docA.export({ mode: 'update' }));

    const merged = readBody(mirrorA);
    expect(merged).toContain('revised by A');
    expect(merged).toContain('revised by B');
    expect(readBody(mirrorB)).toBe(merged);

    mirrorA.dispose();
    mirrorB.dispose();
  });

  it('converges to the same body on both replicas', () => {
    const docA = new LoroDoc();
    const docB = new LoroDoc();
    const mirrorA = openTask(docA);
    setBody(mirrorA, 'Shared line.\n');
    docB.import(docA.export({ mode: 'update' }));
    const mirrorB = openTask(docB);

    setBody(mirrorA, 'Shared line.\n\nAppended by A.\n');
    setBody(mirrorB, 'Prepended by B.\n\nShared line.\n');

    docA.import(docB.export({ mode: 'update' }));
    docB.import(docA.export({ mode: 'update' }));

    expect(readBody(mirrorA)).toBe(readBody(mirrorB));
    expect(readBody(mirrorA)).toContain('Appended by A');
    expect(readBody(mirrorA)).toContain('Prepended by B');

    mirrorA.dispose();
    mirrorB.dispose();
  });
});
