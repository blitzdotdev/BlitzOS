import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { LayoutGrid, List } from 'lucide-react';

import { TabPillStrip, type TabPillItem } from '@/components/shared/tab-pill-strip';

type ViewKey = 'board' | 'list';

const meta: Meta<typeof TabPillStrip<ViewKey>> = {
  title: 'Components/TabPillStrip',
  component: TabPillStrip,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof meta>;

interface Props {
  items: TabPillItem<ViewKey>[];
  activeKey: ViewKey;
  ariaLabel: string;
}

function InteractiveStrip(args: Props) {
  const [activeKey, setActiveKey] = useState<ViewKey>(args.activeKey);
  return <TabPillStrip {...args} activeKey={activeKey} onSelect={setActiveKey} />;
}

const items: TabPillItem<ViewKey>[] = [
  { key: 'board', label: 'Board', icon: LayoutGrid },
  { key: 'list', label: 'List', icon: List },
];

export const BoardActive: Story = {
  args: {
    items,
    activeKey: 'board',
    ariaLabel: 'Task view',
    onSelect: () => undefined,
  },
  render: (args) => <InteractiveStrip {...args} />,
};

export const ListActive: Story = {
  args: {
    items,
    activeKey: 'list',
    ariaLabel: 'Task view',
    onSelect: () => undefined,
  },
  render: (args) => <InteractiveStrip {...args} />,
};

export const NoIcons: Story = {
  args: {
    items: [
      { key: 'board', label: 'Board' },
      { key: 'list', label: 'List' },
    ],
    activeKey: 'board',
    ariaLabel: 'Task view',
    onSelect: () => undefined,
  },
  render: (args) => <InteractiveStrip {...args} />,
};
