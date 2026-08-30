import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { Monitor } from 'lucide-react';

import {
  MobileFilterPillBar,
  type FilterPill,
} from '@/components/mobile/mobile-filter-pill-bar';

const allMachines = ['zx-macbook', 'lab-m2', 'mini-offline'];

function StoryShell() {
  const [scope, setScope] = useState('all');
  const [status, setStatus] = useState('all');
  const [machines, setMachines] = useState<Set<string>>(new Set(allMachines));

  const pills: FilterPill[] = [
    {
      kind: 'single',
      id: 'scope',
      fallbackLabel: 'Scope',
      options: [
        { id: 'all', label: '全部' },
        { id: 'mine', label: '我的' },
        { id: 'team', label: '团队' },
      ],
      selectedId: scope,
      onSelect: setScope,
    },
    {
      kind: 'single',
      id: 'status',
      fallbackLabel: 'Status',
      options: [
        { id: 'all', label: '全部状态' },
        { id: 'working', label: '运行中' },
        { id: 'waiting', label: '等待批准' },
        { id: 'idle', label: '空闲' },
      ],
      selectedId: status,
      onSelect: setStatus,
    },
    {
      kind: 'multi',
      id: 'machines',
      label: 'Machines',
      options: allMachines.map((m) => ({
        id: m,
        label: m,
        icon: <Monitor className="h-3 w-3" />,
      })),
      selectedIds: machines,
      defaultIds: new Set(allMachines),
      onChange: setMachines,
    },
  ];

  return (
    <div className="flex min-h-dvh items-center justify-center bg-stone-200 p-0 sm:p-6">
      <div className="h-dvh w-full overflow-hidden bg-background shadow-2xl sm:h-[852px] sm:w-[393px] sm:rounded-[34px]">
        <div className="border-b pt-3">
          <MobileFilterPillBar pills={pills} />
        </div>
        <div className="space-y-2 p-4 text-xs">
          <div>scope = <code>{scope}</code></div>
          <div>status = <code>{status}</code></div>
          <div>machines = <code>{Array.from(machines).join(', ') || '(none)'}</code></div>
          <p className="pt-3 text-muted-foreground">
            Single-select pills auto-close on commit. Multi-select stays open so the user
            can toggle several. The active-dot on "Machines" appears whenever the selection
            differs from the default (all machines).
          </p>
        </div>
      </div>
    </div>
  );
}

const meta = {
  title: 'Mobile/MobileFilterPillBar',
  component: StoryShell,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof StoryShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
