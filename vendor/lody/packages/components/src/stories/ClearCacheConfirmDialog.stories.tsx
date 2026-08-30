import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { ClearCacheConfirmDialog } from '@/components/settings/clear-cache';

const meta: Meta<typeof ClearCacheConfirmDialog> = {
  title: 'Components/ClearCacheConfirmDialog',
  component: ClearCacheConfirmDialog,
  args: {
    open: true,
    isClearing: false,
    onOpenChange: fn(),
    onConfirm: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof ClearCacheConfirmDialog>;

export const Idle: Story = {};

export const Clearing: Story = {
  args: {
    isClearing: true,
  },
};
