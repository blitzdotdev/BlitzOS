import type { Meta, StoryObj } from '@storybook/react';
import { Folder } from 'lucide-react';

import { MobileInitialLetterAvatar } from '@/components/mobile/mobile-initial-letter-avatar';

function StoryShell() {
  const projects = [
    { name: 'lody', seed: 'zx-macbook:lody' },
    { name: 'loro', seed: 'zx-macbook:loro' },
    { name: 'lody-mobile', seed: 'lab-m2:lody-mobile' },
    { name: 'data-platform', seed: 'lab-m2:data-platform' },
    { name: 'Onboarding scratch', seed: 'mini-offline:onboarding' },
    { name: '中文项目', seed: 'zx-macbook:zh-project' },
    { name: '', seed: 'zx-macbook:empty' },
  ];

  return (
    <div className="flex min-h-dvh items-center justify-center bg-stone-200 p-6">
      <div className="flex w-full max-w-md flex-col gap-6 rounded-2xl bg-background p-6 shadow-2xl">
        {(['sm', 'md', 'lg'] as const).map((size) => (
          <div key={size}>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              size = {size}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {projects.map((p) => (
                <div key={`${size}-${p.seed}`} className="flex items-center gap-2">
                  <MobileInitialLetterAvatar
                    name={p.name}
                    hashSeed={p.seed}
                    size={size}
                    fallbackIcon={<Folder className="h-3 w-3" />}
                  />
                  <span className="text-xs text-muted-foreground">{p.name || '(empty)'}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const meta = {
  title: 'Mobile/MobileInitialLetterAvatar',
  component: StoryShell,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof StoryShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
