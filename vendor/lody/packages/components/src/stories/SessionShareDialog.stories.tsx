import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import type { LocalProjectId, MachineId } from '@lody/shared';
import { SessionShareDialog } from '@/components/session-sharing';

const meta = {
  title: 'Sessions/SessionShareDialog',
  component: SessionShareDialog,
  args: {
    open: true,
    sessionTitle: 'Fix team sharing',
    state: {
      visibility: 'private',
      privateReason: 'machine-and-project',
      canManage: true,
      machineId: 'machine-story' as MachineId,
      localProjectId: 'project-story' as LocalProjectId,
      machineName: 'Studio Mac',
      projectName: 'lody',
    },
    isSharing: false,
    onOpenChange: fn(),
    onConfirm: fn(),
  },
} satisfies Meta<typeof SessionShareDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PrivateMachineAndProject: Story = {};

export const Sharing: Story = {
  args: { isSharing: true },
};
