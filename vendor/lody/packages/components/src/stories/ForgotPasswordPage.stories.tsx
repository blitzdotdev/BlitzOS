import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { ForgotPasswordPage } from '@/components/pages/forgot-password-page';

const meta = {
  title: 'Components/ForgotPasswordPage',
  component: ForgotPasswordPage,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  args: {
    email: 'user@example.com',
    onEmailChange: fn(),
    onSubmit: fn(),
    onBackToLogin: fn(),
  },
} satisfies Meta<typeof ForgotPasswordPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Sent: Story = {
  args: {
    sent: true,
  },
};

export const Error: Story = {
  args: {
    submitError: 'Unable to send reset email. Please try again.',
  },
};
