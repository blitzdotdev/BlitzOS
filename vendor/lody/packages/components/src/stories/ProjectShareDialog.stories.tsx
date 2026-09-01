import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import type { LocalProjectId, MachineId } from '@lody/shared';

import { ProjectShareDialog } from '@/components/session-sharing';

const meta = {
  title: 'Chat/ProjectShareDialog',
  component: ProjectShareDialog,
  args: {
    open: true,
    state: {
      visibility: 'private',
      privateReason: 'machine-and-project',
      canManage: true,
      machineId: 'machine-project-share-story' as MachineId,
      localProjectId: 'project-share-story' as LocalProjectId,
      machineName: 'Studio Mac',
      projectName: 'lody',
    },
    isSharing: false,
    onOpenChange: fn(),
    onConfirm: fn(),
  },
} satisfies Meta<typeof ProjectShareDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PrivateProjectAndMachine: Story = {};

export const Sharing: Story = {
  args: { isSharing: true },
};
