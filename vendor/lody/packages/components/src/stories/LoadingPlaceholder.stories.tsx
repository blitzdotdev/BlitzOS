import type { Meta, StoryObj } from '@storybook/react';

import { LoadingPlaceholder } from '@/components/loading-placeholder';

const meta = {
  title: 'Components/LoadingPlaceholder',
  component: LoadingPlaceholder,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof LoadingPlaceholder>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    title: 'Loading',
  },
};

export const WithDescription: Story = {
  args: {
    title: 'Loading workspace',
    description: 'Fetching your workspace list.',
  },
};

export const AuthFlow: Story = {
  args: {
    title: 'Preparing your account',
    description: 'Finishing sign-in so we can link your email.',
  },
};
