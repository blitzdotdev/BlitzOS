import type { Meta, StoryObj } from '@storybook/react';
import type { PendingScheduledTask } from '@lody/shared';
import { ScheduledTasksPanel } from '@/components/sessions/scheduled-tasks-panel';

const now = Date.now();

// A one-shot cron that fires ~4 minutes from now (anchored at creation), so the story
// stays illustrative regardless of when it is viewed.
const soon = new Date(now + 4 * 60_000);
const oneShotExpr = `${soon.getMinutes()} ${soon.getHours()} ${soon.getDate()} ${soon.getMonth() + 1} *`;

const wakeup: PendingScheduledTask = {
  id: 'wakeup',
  kind: 'wakeup',
  createdAtMs: now,
  scheduledForMs: now + 120_000,
  summary: 'ScheduleWakeup 测试时间到！请回复用户告知定时唤醒测试成功。',
};

const cronOneShot: PendingScheduledTask = {
  id: 'ab9963d6',
  kind: 'cron',
  createdAtMs: now,
  humanSchedule: oneShotExpr,
  recurring: false,
  durable: false,
  summary: '2 分钟时间到了！后台任务完成，请返回结果给用户。',
};

// A one-shot cron whose fire time is already in the past: the panel hides it.
const cronFired: PendingScheduledTask = {
  id: 'fired-job',
  kind: 'cron',
  createdAtMs: now - 10 * 60_000,
  humanSchedule: (() => {
    const past = new Date(now - 5 * 60_000);
    return `${past.getMinutes()} ${past.getHours()} ${past.getDate()} ${past.getMonth() + 1} *`;
  })(),
  recurring: false,
  durable: false,
  summary: 'This one-shot already fired — it should not appear.',
};

const cronRecurring: PendingScheduledTask = {
  id: 'weekday-standup',
  kind: 'cron',
  createdAtMs: now,
  humanSchedule: '0 9 * * 1-5',
  recurring: true,
  durable: true,
  summary: 'Post the weekday standup summary to the channel.',
};

const meta: Meta<typeof ScheduledTasksPanel> = {
  title: 'Sessions/ScheduledTasksPanel',
  component: ScheduledTasksPanel,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <div style={{ width: 420 }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof ScheduledTasksPanel>;

export const WakeupOnly: Story = {
  args: { tasks: [wakeup] },
};

export const CronOnly: Story = {
  args: { tasks: [cronOneShot] },
};

export const Recurring: Story = {
  args: { tasks: [cronRecurring] },
};

export const Mixed: Story = {
  args: { tasks: [wakeup, cronOneShot, cronRecurring] },
};

// The already-fired one-shot is filtered out; only the recurring job renders.
export const FiredHidden: Story = {
  args: { tasks: [cronFired, cronRecurring] },
};

export const Empty: Story = {
  args: { tasks: [] },
};
