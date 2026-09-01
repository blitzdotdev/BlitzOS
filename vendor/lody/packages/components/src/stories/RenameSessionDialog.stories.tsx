import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import type { SessionId } from '@lody/shared';
import { RenameSessionDialogView } from '@/components/sessions/rename-session-dialog';

const meta = {
  title: 'Components/RenameSessionDialog',
  component: RenameSessionDialogView,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  args: {
    target: {
      sessionId: 'rename-session' as SessionId,
      initialTitle: 'Improve rename chat',
    },
    onClose: fn(),
    onRename: fn(),
  },
} satisfies Meta<typeof RenameSessionDialogView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WrappingTitle: Story = {
  args: {
    target: {
      sessionId: 'rename-session' as SessionId,
      initialTitle:
        'Polish the Rename Chat experience so longer conversation names remain easy to review',
    },
  },
};
