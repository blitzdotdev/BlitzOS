import type { Meta, StoryObj } from '@storybook/react';
import {
  AgentActivityIndicator,
  type AgentActivityTone,
} from '@/components/shared/agent-activity-indicator';

const toneVariants: Array<{ tone: AgentActivityTone; label: string }> = [
  { tone: 'primary', label: 'Thinking' },
  { tone: 'warning', label: 'Needs attention' },
  { tone: 'success', label: 'Completed' },
  { tone: 'destructive', label: 'Blocked' },
  { tone: 'neutral', label: 'Idle' },
];

function ToneGrid({ withLabels }: { withLabels: boolean }) {
  return (
    <div className="grid gap-3 text-foreground">
      {toneVariants.map(({ tone, label }) => (
        <div
          key={tone}
          className="flex min-w-64 items-center justify-between gap-6 rounded-lg border border-border bg-card px-4 py-3"
        >
          <span className="text-sm font-medium capitalize text-muted-foreground">{tone}</span>
          <AgentActivityIndicator
            tone={tone}
            label={withLabels ? label : undefined}
            labelHighlightIntervalMs={90}
            labelHighlightPauseMs={1200}
          />
        </div>
      ))}
    </div>
  );
}

const meta = {
  title: 'Shared/AgentActivityIndicator',
  component: AgentActivityIndicator,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="rounded-xl border border-border bg-background p-6 text-foreground shadow-xs">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AgentActivityIndicator>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    color: '#7dd3fc',
  },
};

export const Thinking: Story = {
  args: {
    tone: 'primary',
    label: 'Thinking',
  },
};

export const ToneVariants: Story = {
  render: () => <ToneGrid withLabels />,
};

export const ToneDots: Story = {
  render: () => <ToneGrid withLabels={false} />,
};

export const ExploringFiles: Story = {
  args: {
    tone: 'neutral',
    label: 'Exploring files',
    labelHighlightIntervalMs: 2,
  },
};

export const CustomColor: Story = {
  args: {
    color: '#a78bfa',
    label: 'Custom color',
  },
};

export const Warm: Story = {
  args: {
    color: '#fbbf24',
  },
};

export const Electric: Story = {
  args: {
    color: '#a78bfa',
  },
};

export const Small: Story = {
  args: {
    color: '#5eead4',
    displaySize: 20,
    canvasSize: 40,
  },
};
