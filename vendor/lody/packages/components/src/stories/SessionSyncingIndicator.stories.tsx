import type { Meta, StoryObj } from '@storybook/react';

import { SessionSyncingIndicator } from '@/components/sessions/session-syncing-indicator';

const meta = {
  title: 'Sessions/SessionSyncingIndicator',
  component: SessionSyncingIndicator,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof SessionSyncingIndicator>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
