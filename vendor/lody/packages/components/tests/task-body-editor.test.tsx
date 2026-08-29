import { describe, expect, it } from 'vitest';

import { shouldAdoptRemoteBody } from '../src/components/tasks/task-body-editor';

/**
 * The body editor is meowdown (WYSIWYG over the same stored Markdown), which
 * mounts custom elements and a ProseMirror view that jsdom cannot host. The
 * rendering, typing, styling and dark-mode behaviour are verified in a real
 * browser through `TaskBodyEditor.stories.tsx`; what is unit-tested here is the
 * decision that carries the actual risk — when text arriving from the document
 * layer is allowed to replace what the person is looking at.
 *
 * The two obsolete tests this file used to hold (the rendered body must not be
 * nested in a <button>, and a real Edit button must exist) described the
 * textarea-plus-preview UI. WYSIWYG removes that mode switch entirely, so those
 * assertions no longer describe anything: there is no preview to click into and
 * no wrapper button to get wrong.
 */
describe('shouldAdoptRemoteBody', () => {
  it('adopts a genuine remote change when the field is idle', () => {
    expect(
      shouldAdoptRemoteBody({ incoming: 'remote text', lastSynced: 'old text', editing: false })
    ).toBe(true);
  });

  it('refuses to adopt anything while the user is typing', () => {
    // Adopting here would reflow the paragraph under the caret mid-sentence.
    expect(
      shouldAdoptRemoteBody({ incoming: 'remote text', lastSynced: 'old text', editing: true })
    ).toBe(false);
  });

  it('ignores the echo of our own commit', () => {
    // A local commit goes to Loro and returns through the mirror. Treating that
    // as a remote edit would replace the document the user is still working in.
    expect(
      shouldAdoptRemoteBody({ incoming: 'my text', lastSynced: 'my text', editing: false })
    ).toBe(false);
  });

  it('treats an empty remote body as a real change, not a missing value', () => {
    // Clearing the description elsewhere is a legitimate edit; falsiness must
    // not be mistaken for "nothing arrived".
    expect(shouldAdoptRemoteBody({ incoming: '', lastSynced: 'old text', editing: false })).toBe(
      true
    );
  });

  it('still refuses an empty remote body while editing', () => {
    expect(shouldAdoptRemoteBody({ incoming: '', lastSynced: 'old text', editing: true })).toBe(
      false
    );
  });
});
