import type { Meta, StoryObj } from '@storybook/react';
import { OnboardingBackdrop, OnboardingLoadingView } from '@/components/onboarding';

function LoadingPreviewWrapper({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-[640px] w-full">
      <OnboardingBackdrop />
      <div className="relative z-10 flex min-h-[640px] items-center justify-center p-8">
        {children}
      </div>
    </div>
  );
}

const meta = {
  title: 'Onboarding/OnboardingLoading',
  component: OnboardingLoadingView,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <LoadingPreviewWrapper>
        <Story />
      </LoadingPreviewWrapper>
    ),
  ],
} satisfies Meta<typeof OnboardingLoadingView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Bootstrap: Story = {
  args: {
    phase: 'starting',
    stage: 'bootstrap',
  },
};

export const Auth: Story = {
  args: {
    phase: 'starting',
    stage: 'auth',
  },
};

export const SyncTime: Story = {
  args: {
    phase: 'starting',
    stage: 'sync-time',
  },
};

export const FleetStart: Story = {
  args: {
    phase: 'starting',
    stage: 'fleet-start',
  },
};

export const ReadyButNotRunning: Story = {
  args: {
    phase: 'starting',
    stage: 'ready',
  },
};

export const Running: Story = {
  args: {
    phase: 'running',
    stage: 'ready',
  },
};

export const BypassedAfterTimeout: Story = {
  args: {
    phase: 'starting',
    stage: 'fleet-start',
    bypassed: true,
  },
};
