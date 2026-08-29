import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { fn } from 'storybook/test';

import { GitHubPersonalIdentitySettingsCard } from '@/components/settings/integrations-setting';
import type { GitHubPersonalIdentitySettingsCardProps } from '@/components/settings/integrations-setting';

const meta = {
  title: 'Settings/GitHubPersonalIdentitySettingsCard',
  component: GitHubPersonalIdentitySettingsCard,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  args: {
    enabled: false,
    authorizationState: 'missing',
    workspaceReady: true,
    settingsLoading: false,
    updating: false,
    authorizing: false,
    onToggle: fn(),
    onAuthorize: fn(),
  },
  render: (args) => <InteractiveCard {...args} />,
} satisfies Meta<typeof GitHubPersonalIdentitySettingsCard>;

export default meta;
type Story = StoryObj<typeof meta>;

function InteractiveCard(args: GitHubPersonalIdentitySettingsCardProps) {
  const [enabled, setEnabled] = useState(args.enabled);

  return (
    <div className="w-[min(92vw,680px)] bg-background p-4 text-foreground">
      <GitHubPersonalIdentitySettingsCard
        {...args}
        enabled={enabled}
        onToggle={(nextEnabled) => {
          setEnabled(nextEnabled);
          args.onToggle(nextEnabled);
        }}
      />
    </div>
  );
}

export const Disabled: Story = {};

export const NeedsAuthorization: Story = {
  args: {
    enabled: true,
    authorizationState: 'missing',
  },
};

export const Authorized: Story = {
  args: {
    enabled: true,
    authorizationState: 'authorized',
    githubAccountId: '12345678',
    profile: {
      login: 'octocat',
      name: 'The Octocat',
      avatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=4',
      htmlUrl: 'https://github.com/octocat',
    },
  },
};

export const AuthorizedNoProfile: Story = {
  args: {
    enabled: true,
    authorizationState: 'authorized',
    githubAccountId: '583231',
  },
};

export const Expired: Story = {
  args: {
    enabled: true,
    authorizationState: 'expired',
    githubAccountId: '12345678',
    profile: {
      login: 'octocat',
      avatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=4',
    },
  },
};

export const Authorizing: Story = {
  args: {
    enabled: true,
    authorizationState: 'missing',
    authorizing: true,
  },
};

export const Loading: Story = {
  args: {
    enabled: false,
    settingsLoading: true,
  },
};
