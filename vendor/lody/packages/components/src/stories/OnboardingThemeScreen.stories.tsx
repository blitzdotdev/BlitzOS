import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { fn } from 'storybook/test';
import { OnboardingBackdrop, ThemeScreenView } from '@/components/onboarding';

function ThemePreviewWrapper({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-[760px] w-full">
      <OnboardingBackdrop />
      <div className="relative z-10 flex min-h-[760px] items-center justify-center p-8">
        {children}
      </div>
    </div>
  );
}

function InteractiveThemeScreen() {
  const [mode, setMode] = useState<'light' | 'dark' | 'system'>('dark');
  return <ThemeScreenView mode={mode} onModeChange={setMode} onBack={fn()} onNext={fn()} />;
}

const meta = {
  title: 'Onboarding/ThemeScreen',
  component: ThemeScreenView,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  args: {
    onModeChange: fn(),
    onBack: fn(),
    onNext: fn(),
  },
  decorators: [
    (Story) => (
      <ThemePreviewWrapper>
        <Story />
      </ThemePreviewWrapper>
    ),
  ],
} satisfies Meta<typeof ThemeScreenView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DarkMode: Story = {
  args: {
    mode: 'dark',
  },
};

export const LightMode: Story = {
  args: {
    mode: 'light',
  },
};

export const SystemMode: Story = {
  args: {
    mode: 'system',
  },
};

export const Interactive: Story = {
  args: {
    mode: 'dark',
  },
  render: () => <InteractiveThemeScreen />,
};
