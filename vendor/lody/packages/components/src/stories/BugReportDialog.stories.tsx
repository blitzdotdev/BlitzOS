import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import type { MachineId } from '@lody/shared';
import {
  BugReportDialog,
  type BugReportMachineOption,
} from '@/components/bug-report/bug-report-dialog';

const machines: BugReportMachineOption[] = [
  { id: 'machine-macbook' as MachineId, name: "Zoe's MacBook Pro" },
  { id: 'machine-desktop' as MachineId, name: 'dev-desktop' },
  { id: 'machine-hel' as MachineId, name: 'ubuntu-8gb-hel1-1' },
];

const meta: Meta<typeof BugReportDialog> = {
  title: 'Components/BugReportDialog',
  component: BugReportDialog,
  args: {
    open: true,
    machines,
    initialMachineId: machines[0]?.id ?? null,
    state: { status: 'idle' },
    onSubmit: fn(),
    onClose: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof BugReportDialog>;

export const Idle: Story = {};

export const NoMachineSelected: Story = {
  args: {
    initialMachineId: null,
  },
};

export const Submitting: Story = {
  args: {
    state: { status: 'submitting' },
  },
};

export const Success: Story = {
  args: {
    state: { status: 'success', bugReportId: 'k57c2mvf8q1zx0e9w3jh4t6ya', withLogs: true },
  },
};

export const SuccessWithoutLogs: Story = {
  args: {
    state: { status: 'success', bugReportId: 'k57c2mvf8q1zx0e9w3jh4t6ya', withLogs: false },
  },
};

export const ErrorState: Story = {
  args: {
    state: {
      status: 'error',
      message: 'The machine did not respond. Make sure it is online and try again.',
    },
  },
};

export const NoMachines: Story = {
  args: {
    machines: [],
    initialMachineId: null,
  },
};
