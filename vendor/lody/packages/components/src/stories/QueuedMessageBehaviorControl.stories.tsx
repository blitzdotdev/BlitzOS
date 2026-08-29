import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import {
  QueuedMessageBehaviorControl,
  type QueuedMessageBehaviorControlProps,
} from '@/components/settings/queued-message-behavior-control';

const meta = {
  title: 'Settings/QueuedMessageBehaviorControl',
  component: QueuedMessageBehaviorControl,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof QueuedMessageBehaviorControl>;

export default meta;
type Story = StoryObj<typeof meta>;

function Controlled(args: QueuedMessageBehaviorControlProps) {
  const [value, setValue] = useState(args.value);
  return <QueuedMessageBehaviorControl {...args} value={value} onChange={setValue} />;
}

export const QueueSelected: Story = {
  args: { value: 'queue', onChange: () => {} },
  render: (args) => <Controlled {...args} />,
};

export const GuideSelected: Story = {
  args: { value: 'guide', onChange: () => {} },
  render: (args) => <Controlled {...args} />,
};
