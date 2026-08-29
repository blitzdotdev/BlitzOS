// @vitest-environment jsdom

import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import type { AskUserQuestionPermissionMeta } from '@lody/shared';

import { AskUserQuestionCard } from '../src/components/sessions/ask-user-question-card';
import { TooltipProvider } from '../src/ui/tooltip';
import { initI18n } from '../src/i18n';

const meta: AskUserQuestionPermissionMeta = {
  source: 'codex',
  version: 1,
  allowCustomAnswer: false,
  questions: [
    {
      header: 'Breakfast',
      question: 'Pick ingredients',
      multiSelect: true,
      options: [{ label: 'Eggs' }, { label: 'Toast' }],
    },
    {
      header: 'Drink',
      question: 'Pick a drink',
      multiSelect: false,
      options: [{ label: 'Coffee' }, { label: 'Tea' }],
    },
  ],
};

const metaWithInfo: AskUserQuestionPermissionMeta = {
  source: 'codex',
  version: 1,
  allowCustomAnswer: false,
  questions: [
    {
      header: 'Strategy',
      question: 'Pick a strategy',
      multiSelect: false,
      options: [
        {
          label: 'Use a Map',
          description: 'Best when keys are dynamic',
          preview: 'const cache = new Map();',
        },
        { label: 'Use a plain object' },
      ],
    },
  ],
};

function dispatchTouchPointer(
  target: EventTarget,
  type: string,
  init: { x: number; y: number; pointerId?: number }
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.x,
    clientY: init.y,
  });
  Object.defineProperties(event, {
    pointerId: { value: init.pointerId ?? 1 },
    pointerType: { value: 'touch' },
    isPrimary: { value: true },
  });
  target.dispatchEvent(event);
}

function getButton(container: HTMLElement, label: string): HTMLElement {
  // Option containers are <div role="button"> so the inline info icon can
  // nest next to the label; navigation/submit buttons stay native <button>.
  const button = [
    ...container.querySelectorAll<HTMLElement>('button, [role="button"]'),
  ].find((candidate) => candidate.textContent?.includes(label));
  if (!button) {
    throw new Error(`Expected button "${label}" to be rendered`);
  }
  return button;
}

describe('AskUserQuestionCard touch navigation', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
  });

  afterEach(() => {
    if (root) {
      flushSync(() => {
        root?.unmount();
      });
    }
    root = undefined;
    container?.remove();
    container = undefined;
  });

  function renderCard() {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    flushSync(() => {
      root?.render(
        createElement(AskUserQuestionCard, {
          meta,
          mode: {
            kind: 'interactive',
            isReady: true,
            isPendingSubmit: false,
            isPendingCancel: false,
            disabled: false,
            onSubmit: vi.fn(),
            onCancel: vi.fn(),
          },
        })
      );
    });

    const card = container.firstElementChild;
    if (!(card instanceof HTMLElement)) {
      throw new Error('Expected the question card to render');
    }
    return card;
  }

  it('advances to the next question on a left touch swipe after the current answer is complete', () => {
    const card = renderCard();
    expect(container?.textContent).toContain('Pick ingredients');

    flushSync(() => {
      getButton(container!, 'Eggs').click();
    });

    flushSync(() => {
      dispatchTouchPointer(card, 'pointerdown', { x: 220, y: 80 });
      dispatchTouchPointer(card, 'pointermove', { x: 150, y: 82 });
      dispatchTouchPointer(card, 'pointerup', { x: 120, y: 82 });
    });

    expect(container?.textContent).toContain('Pick a drink');
  });

  it('does not advance on a left touch swipe when the current answer is incomplete', () => {
    const card = renderCard();

    flushSync(() => {
      dispatchTouchPointer(card, 'pointerdown', { x: 220, y: 80 });
      dispatchTouchPointer(card, 'pointermove', { x: 150, y: 82 });
      dispatchTouchPointer(card, 'pointerup', { x: 120, y: 82 });
    });

    expect(container?.textContent).toContain('Pick ingredients');
    expect(container?.textContent).not.toContain('Pick a drink');
  });
});

describe('AskUserQuestionCard submit behavior', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
  });

  afterEach(() => {
    if (root) {
      flushSync(() => {
        root?.unmount();
      });
    }
    root = undefined;
    container?.remove();
    container = undefined;
  });

  function renderInteractiveCard(onSubmit: ReturnType<typeof vi.fn>) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    flushSync(() => {
      root?.render(
        createElement(AskUserQuestionCard, {
          meta,
          mode: {
            kind: 'interactive',
            isReady: true,
            isPendingSubmit: false,
            isPendingCancel: false,
            disabled: false,
            onSubmit,
            onCancel: vi.fn(),
          },
        })
      );
    });
  }

  it('does not submit when the user clicks the last single-select option', async () => {
    const onSubmit = vi.fn();
    renderInteractiveCard(onSubmit);

    flushSync(() => {
      getButton(container!, 'Eggs').click();
    });
    flushSync(() => {
      getButton(container!, 'Next').click();
    });

    expect(container?.textContent).toContain('Pick a drink');

    flushSync(() => {
      getButton(container!, 'Coffee').click();
    });

    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits only when the user clicks the Submit button after answering all questions', async () => {
    const onSubmit = vi.fn();
    renderInteractiveCard(onSubmit);

    flushSync(() => {
      getButton(container!, 'Eggs').click();
    });
    flushSync(() => {
      getButton(container!, 'Next').click();
    });
    flushSync(() => {
      getButton(container!, 'Coffee').click();
    });

    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
    expect(onSubmit).not.toHaveBeenCalled();

    flushSync(() => {
      getButton(container!, 'Submit').click();
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const submittedAnswers = onSubmit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.values(submittedAnswers)).toEqual(expect.arrayContaining([['Eggs'], 'Coffee']));
  });
});

describe('AskUserQuestionCard info button keyboard a11y', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
  });

  afterEach(() => {
    if (root) {
      flushSync(() => {
        root?.unmount();
      });
    }
    root = undefined;
    container?.remove();
    container = undefined;
  });

  function renderWithInfo(onSubmit = vi.fn()) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    flushSync(() => {
      root?.render(
        createElement(
          TooltipProvider,
          { delayDuration: 0 },
          createElement(AskUserQuestionCard, {
            meta: metaWithInfo,
            mode: {
              kind: 'interactive',
              isReady: true,
              isPendingSubmit: false,
              isPendingCancel: false,
              disabled: false,
              onSubmit,
              onCancel: vi.fn(),
            },
          })
        )
      );
    });
  }

  it('opens the info dialog (not the parent option) when Enter is pressed on the (i) button', () => {
    renderWithInfo();

    const infoButton = container!.querySelector<HTMLButtonElement>(
      'button[aria-label="Show details"]'
    );
    if (!infoButton) throw new Error('Expected an info button to be rendered');

    flushSync(() => {
      infoButton.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      );
      // jsdom does not synthesize the native Enter→click; emit it explicitly
      // to model what a real browser does AFTER the option's outer handler
      // (correctly) opts out of preventing the default.
      infoButton.click();
    });

    expect(document.body.textContent).toContain('Best when keys are dynamic');
    // The parent option must not have been toggled by the bubbled keydown.
    const optionRow = container!.querySelector<HTMLElement>('[role="button"][aria-pressed]');
    expect(optionRow?.getAttribute('aria-pressed')).toBe('false');
  });
});
