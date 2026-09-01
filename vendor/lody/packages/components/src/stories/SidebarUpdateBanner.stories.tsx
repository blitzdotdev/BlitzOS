import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { SidebarUpdateBanner } from '@/components/sidebar-update-banner';

const meta: Meta<typeof SidebarUpdateBanner> = {
  title: 'Components/SidebarUpdateBanner',
  component: SidebarUpdateBanner,
  args: {
    version: '1.4.2',
    isRestarting: false,
    onViewChangelog: fn(),
    onRestart: fn(),
    onLater: fn(),
  },
  render: (args) => (
    <div className="w-72">
      <SidebarUpdateBanner {...args} />
    </div>
  ),
};

export default meta;
type Story = StoryObj<typeof SidebarUpdateBanner>;

export const Downloading: Story = {
  args: { stage: 'downloading', percent: 38 },
};

// Some feeds report no percent at all; the banner then drops the progress row
// instead of showing a bar stuck at zero.
export const DownloadingWithoutProgress: Story = {
  args: { stage: 'downloading', percent: null },
};

export const Downloaded: Story = {
  args: { stage: 'downloaded', percent: null },
};

export const Restarting: Story = {
  args: { stage: 'downloaded', percent: null, isRestarting: true },
};
