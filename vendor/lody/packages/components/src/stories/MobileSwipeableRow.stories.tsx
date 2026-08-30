import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { fn } from 'storybook/test';
import { Pin } from 'lucide-react';

import {
  MobileSwipeableRow,
  MobileSwipeableRowGroup,
} from '@/components/mobile/mobile-swipeable-row';

type Row = { id: string; title: string; subtitle: string; pinned?: boolean };

const initialRows: Row[] = [
  { id: '1', title: '重构评估 UI', subtitle: 'feat/eval-ui · 30m', pinned: true },
  { id: '2', title: '同步进度提示', subtitle: 'feat/sync-progress · 5h' },
  { id: '3', title: '权限审批弹窗', subtitle: 'fix/permission-modal · 1d' },
  { id: '4', title: '登录页 OAuth', subtitle: 'fix/oauth · 2d' },
  { id: '5', title: '移动端归档体验', subtitle: 'feat/mobile-archive · 3d' },
];

function RowContent({ row, dimmed }: { row: Row; dimmed?: boolean }) {
  return (
    <div className="flex items-center gap-3 bg-card px-4 py-3">
      <div className="h-9 w-9 shrink-0 rounded-lg bg-muted" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          {row.pinned ? (
            <Pin className="h-3 w-3 shrink-0 text-primary" />
          ) : null}
          <span
            className={`truncate text-sm font-medium ${dimmed ? 'text-muted-foreground' : ''}`}
          >
            {row.title}
          </span>
        </div>
        <div className="truncate text-xs text-muted-foreground">{row.subtitle}</div>
      </div>
      <span className="text-xs text-muted-foreground">›</span>
    </div>
  );
}

function StoryShell({
  grouped,
  variant = 'active',
}: {
  grouped: boolean;
  variant?: 'active' | 'archived';
}) {
  const [rows, setRows] = useState(initialRows);
  const archived = variant === 'archived';

  const togglePin = (id: string) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, pinned: !r.pinned } : r)));
  };
  const removeRow = (id: string) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
    fn()(id);
  };

  const list = (
    <div className="overflow-hidden rounded-2xl border border-border/40 bg-card">
      {rows.map((row, i) => (
        <div key={row.id} className={i > 0 ? 'border-t border-border/40' : ''}>
          {archived ? (
            <MobileSwipeableRow
              variant="archived"
              onRestore={() => removeRow(row.id)}
              onDelete={() => removeRow(row.id)}
              restoreAriaLabel="恢复"
              deleteAriaLabel="删除"
            >
              <RowContent row={row} dimmed />
            </MobileSwipeableRow>
          ) : (
            <MobileSwipeableRow
              isPinned={row.pinned}
              onTogglePin={() => togglePin(row.id)}
              onArchive={() => removeRow(row.id)}
              pinAriaLabel="Pin"
              unpinAriaLabel="Unpin"
              archiveAriaLabel="Archive"
            >
              <RowContent row={row} />
            </MobileSwipeableRow>
          )}
        </div>
      ))}
    </div>
  );

  return (
    <div className="flex min-h-dvh items-center justify-center bg-stone-200 p-0 sm:p-6">
      <div className="h-dvh w-full overflow-y-auto bg-background pb-12 shadow-2xl sm:h-[852px] sm:w-[393px] sm:rounded-[34px]">
        <div className="px-5 pb-1 pt-6 text-xl font-semibold">
          {archived ? '归档对话 — 左滑恢复 / 删除' : 'Swipe a row left'}
        </div>
        <p className="px-5 pb-3 text-xs text-muted-foreground">
          {archived
            ? '归档列表：左滑漏出「恢复」和「删除」,没有 super-swipe(删除不可逆,需走确认)。'
            : grouped
              ? '所有 row 共享 group — 滑开一行,其它会自动收回(iOS Mail 行为)。'
              : '没有 group — 每一行独立,可以同时打开多行 drawer。'}
        </p>
        <div className="px-3">
          {grouped ? <MobileSwipeableRowGroup>{list}</MobileSwipeableRowGroup> : list}
        </div>
      </div>
    </div>
  );
}

const meta = {
  title: 'Mobile/MobileSwipeableRow',
  component: StoryShell,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof StoryShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Grouped: Story = {
  args: { grouped: true },
};

export const Standalone: Story = {
  args: { grouped: false },
};

export const Archived: Story = {
  args: { grouped: true, variant: 'archived' },
};
