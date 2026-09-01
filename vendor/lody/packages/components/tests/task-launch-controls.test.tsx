// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TaskLaunchControls } from '../src/components/tasks/task-launch-controls';
import { TooltipProvider } from '../src/ui/tooltip';
import { initI18n } from '../src/i18n';

const agentOptions = [
  { agentConfigId: 'a1', name: 'Design Agent', homeName: 'MacBook Pro', presence: 'online' as const },
  {
    agentConfigId: 'a2',
    name: 'Codex @ Workstation',
    homeName: 'Workstation',
    presence: 'offline' as const,
  },
  { agentConfigId: 'a3', name: 'Kimi', homeName: 'MacBook Pro', presence: 'unknown' as const },
];

const projectOptions = [
  { key: 'local::p1', label: 'lody', machineName: 'MacBook Pro', reachable: true },
];

type Props = Parameters<typeof TaskLaunchControls>[0];

// No `as Props` cast here on purpose: an earlier version used one, which let
// wrong prop names ("selectedAgent" for "agent") through silently, so tests that
// claimed to exercise the offline agent actually ran with no agent at all.
const baseProps = (overrides: Partial<Props>): Props => ({
  agent: null,
  agentOptions,
  project: null,
  projectOptions,
  canRun: true,
  running: false,
  hasActiveSession: false,
  onSelectAgent: vi.fn(),
  onSelectProject: vi.fn(),
  onRun: vi.fn(),
  ...overrides,
});

describe('TaskLaunchControls Run button', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  const render = (props: Props): void => {
    act(() => {
      root.render(
        <TooltipProvider>
          <TaskLaunchControls {...props} />
        </TooltipProvider>
      );
    });
  };

  // The label flips to "Starting…" mid-flight, so match either wording.
  const runButton = (): HTMLButtonElement | undefined =>
    [...container.querySelectorAll('button')].find((button) => {
      const label = (button.textContent ?? '').trim();
      return label.startsWith('Run') || label.startsWith('Starting');
    });

  it('disables Run when required fields are missing', () => {
    render(baseProps({ canRun: false, agent: null, project: null }));

    // Dispatch rejects on missing fields, so an enabled button would look like
    // a press that did nothing at all.
    expect(runButton()?.disabled).toBe(true);
  });

  it('keeps Run enabled when the chosen agent is offline', () => {
    render(
      baseProps({
        canRun: true,
        agent: agentOptions[1],
        project: projectOptions[0],
      })
    );

    // Offline is informational: the dispatch is durable and runs on reconnect,
    // so blocking it here would strand work the user already decided to start.
    expect(runButton()?.disabled).toBe(false);
  });

  it('keeps Run enabled when agent presence is unknown', () => {
    render(
      baseProps({
        canRun: true,
        agent: agentOptions[2],
        project: projectOptions[0],
      })
    );

    // 'unknown' presence must never be treated as offline.
    expect(runButton()?.disabled).toBe(false);
  });

  it('lets a task be delegated before its project is chosen', () => {
    // The board warns about "entrusted but missing a project", so that state has
    // to be reachable; gating delegation on canRun would make it impossible.
    const onToggleDelegation = vi.fn();
    render(
      baseProps({
        canRun: false,
        agent: agentOptions[0],
        project: null,
        delegatedTo: null,
        onToggleDelegation,
      })
    );

    const checkbox = container.querySelector('input[type="checkbox"]');
    expect((checkbox as HTMLInputElement | null)?.disabled).toBe(false);
  });

  it('refuses delegation when no agent has been chosen to hand it to', () => {
    render(
      baseProps({
        canRun: false,
        agent: null,
        project: null,
        delegatedTo: null,
        onToggleDelegation: vi.fn(),
      })
    );

    const checkbox = container.querySelector('input[type="checkbox"]');
    expect((checkbox as HTMLInputElement | null)?.disabled).toBe(true);
  });

  it('reports a toggle so the caller can write or clear the agent field', () => {
    const onToggleDelegation = vi.fn();
    render(
      baseProps({
        canRun: true,
        agent: agentOptions[0],
        project: projectOptions[0],
        delegatedTo: null,
        onToggleDelegation,
      })
    );

    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    act(() => {
      checkbox.click();
    });
    expect(onToggleDelegation).toHaveBeenCalledOnce();
  });

  it('shows the delegated state as checked', () => {
    render(
      baseProps({
        canRun: true,
        agent: agentOptions[0],
        project: projectOptions[0],
        delegatedTo: 'Design Agent',
        onToggleDelegation: vi.fn(),
      })
    );

    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it('disables Run while a start is already in flight', () => {
    render(
      baseProps({
        canRun: true,
        running: true,
        agent: agentOptions[0],
        project: projectOptions[0],
      })
    );

    expect(runButton()?.disabled).toBe(true);
  });
});
