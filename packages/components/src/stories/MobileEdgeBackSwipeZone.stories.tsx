import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { fn } from 'storybook/test';
import { ChevronLeft } from 'lucide-react';

import { EDGE_ZONE_PX, MobileEdgeBackSwipeZone } from '@/components/mobile/mobile-edge-back-swipe';

function StoryShell({
  isNativeApp,
  highlightZone,
}: {
  isNativeApp: boolean;
  highlightZone: boolean;
}) {
  const [count, setCount] = useState(0);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-stone-200 p-0 sm:p-6">
      <div className="relative h-dvh w-full overflow-hidden bg-background shadow-2xl sm:h-[852px] sm:w-[393px] sm:rounded-[34px]">
        <header className="flex h-14 items-center gap-2 border-b px-4">
          <ChevronLeft className="h-5 w-5" />
          <span className="text-sm font-medium">详情页</span>
        </header>
        <div className="space-y-3 p-6 text-sm text-muted-foreground">
          <p>
            从屏幕左边缘向右拉手势(原生应用内)。本 Story 重写了 zone 样式让
            {EDGE_ZONE_PX}px 的命中区域可见。
          </p>
          <p>
            <code>isNativeApp = {String(isNativeApp)}</code>
          </p>
          <p>触发次数: {count}</p>
          <p className="text-xs">
            (Web 端 / isNativeApp=false 时,此组件不挂载 — 让浏览器 / 路由历史负责返回。)
          </p>
        </div>

        <MobileEdgeBackSwipeZone
          isNativeApp={isNativeApp}
          onBack={() => {
            setCount((c) => c + 1);
            fn()();
          }}
        />

        {highlightZone && isNativeApp ? (
          <div
            className="pointer-events-none absolute inset-y-0 left-0 z-40 bg-primary/20 ring-2 ring-primary/40"
            style={{ width: EDGE_ZONE_PX }}
            aria-hidden="true"
          >
            <span
              className="absolute top-1/2 -translate-y-1/2 whitespace-nowrap rounded bg-primary px-2 py-1 text-xs text-primary-foreground"
              style={{ left: EDGE_ZONE_PX }}
            >
              {EDGE_ZONE_PX}px edge zone
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const meta = {
  title: 'Mobile/MobileEdgeBackSwipeZone',
  component: StoryShell,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof StoryShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NativeAppHighlighted: Story = {
  args: { isNativeApp: true, highlightZone: true },
};

export const NativeAppHidden: Story = {
  args: { isNativeApp: true, highlightZone: false },
};

export const WebDisabled: Story = {
  args: { isNativeApp: false, highlightZone: true },
};
