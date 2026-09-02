import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '../src/api.js';
import {
  ErrorReporterProvider,
  useErrorReporter,
  type ReportableError,
} from '../src/error-dialog/ErrorReporter.js';
import { render, settle } from './dom.js';

function ErrorTrigger({ caught }: { caught: ReportableError }) {
  const reportError = useErrorReporter();
  return (
    <button
      type="button"
      onClick={() => reportError(caught, {
        title: 'Couldn’t save credential',
        action: 'Saving DEPLOY_KEY.',
        workspaceId: 'workspace-one',
      })}
    >
      Fail
    </button>
  );
}

describe('ErrorReporterProvider', () => {
  it('shows API diagnostics and copies a plain-text report', async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const view = await render(
      <ErrorReporterProvider>
        <ErrorTrigger caught={new ApiRequestError('credential refused', 409, 'poll')} />
      </ErrorReporterProvider>,
    );

    await act(async () => view.container.querySelector<HTMLButtonElement>('button')?.click());
    const dialog = view.container.querySelector('.webapp-error-dialog');
    expect(dialog?.textContent).toContain('Couldn’t save credential');
    expect(dialog?.textContent).toContain('Status: HTTP 409');
    expect(dialog?.textContent).toContain('Code: poll');
    expect(dialog?.textContent).toContain('credential refused');

    const copy = [...view.container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Copy error'));
    await act(async () => copy?.click());
    await settle();
    expect(writeText).toHaveBeenCalledOnce();
    const report = writeText.mock.calls[0]?.[0];
    expect(report).toContain('Error: Couldn’t save credential');
    expect(report).toContain('Code: poll');
    expect(report).toContain('Status: HTTP 409');
    expect(report).toContain('Workspace: workspace-one');
    expect(report).toContain('Timestamp:');
    expect(report).toContain('credential refused');
    expect(copy?.textContent).toContain('Copied');

    await view.unmount();
    if (originalClipboard === undefined) {
      Reflect.deleteProperty(navigator, 'clipboard');
    } else {
      Object.defineProperty(navigator, 'clipboard', originalClipboard);
    }
  });
});
