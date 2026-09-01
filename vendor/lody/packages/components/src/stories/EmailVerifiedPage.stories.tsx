import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { EmailVerifiedPage } from '@/components/pages/email-verified-page';

const meta = {
  title: 'Pages/EmailVerifiedPage',
  component: EmailVerifiedPage,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  args: {
    email: 'user@example.com',
    secondsRemaining: 3,
    onContinue: fn(),
  },
} satisfies Meta<typeof EmailVerifiedPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithEmail: Story = {};

export const WithoutEmail: Story = {
  args: {
    email: '',
  },
};

export const AboutToRedirect: Story = {
  args: {
    secondsRemaining: 1,
  },
};
