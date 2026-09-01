import type { Meta, StoryObj } from '@storybook/react';

import { DesktopGithubInstallPage } from '@/components/pages/desktop-github-install-page';

const meta = {
  title: 'Pages/DesktopGithubInstallPage',
  component: DesktopGithubInstallPage,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof DesktopGithubInstallPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {
  args: {
    deepLink: 'lody://github-install?installation_id=123',
  },
};

export const WaitingForDeepLink: Story = {
  args: {
    deepLink: null,
  },
};
