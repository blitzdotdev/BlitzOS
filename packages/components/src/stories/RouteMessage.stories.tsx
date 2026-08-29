import type { Meta, StoryObj } from '@storybook/react';
import { RouteMessage } from '@/components/route-message';

const meta = {
  title: 'Components/RouteMessage',
  component: RouteMessage,
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta<typeof RouteMessage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Error: Story = {
  args: {
    title: 'Unable to load workspaces',
    description: 'Please refresh the page and try again.',
  },
};
