import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { CompleteEmailPage } from '@/components/pages/complete-email-page';

const meta = {
  title: 'Pages/CompleteEmailPage',
  component: CompleteEmailPage,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  args: {
    userLabel: 'Storybook User · storybook@lody.ai',
    email: '',
    onEmailChange: fn(),
    onSubmit: fn(),
    onSignOut: fn(),
  },
} satisfies Meta<typeof CompleteEmailPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const WithInput: Story = {
  args: {
    email: 'user@example.com',
  },
};

export const SubmitError: Story = {
  args: {
    email: 'not-an-email',
    submitError: 'Please enter a valid email address.',
  },
};

export const Saving: Story = {
  args: {
    email: 'user@example.com',
    submitting: true,
  },
};

export const SigningOut: Story = {
  args: {
    email: 'user@example.com',
    signingOut: true,
  },
};
