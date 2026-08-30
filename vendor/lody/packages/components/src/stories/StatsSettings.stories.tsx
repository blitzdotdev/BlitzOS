import type { Meta, StoryObj } from '@storybook/react';
import { useMemo, useState } from 'react';
import { StatsSettingsView } from '@/components/settings/stats-setting-pure';
import type { StackedAreaBucket } from '@/components/settings/usage-stacked-area-chart';
import type { SettingsUsageRange } from '@/components/settings/settings-data-cache';

/* Deterministic pseudo-usage so the charts render a believable shape without
   Math.random (stable across story reloads / visual regression). */
const MODELS = [
  { id: 'claude-opus-4-8', label: 'claude-opus-4-8', weight: 5 },
  { id: 'claude-sonnet-5', label: 'claude-sonnet-5', weight: 8 },
  { id: 'gpt-5-codex', label: 'gpt-5-codex', weight: 4 },
  { id: 'gemini-2.5-pro', label: 'gemini-2.5-pro', weight: 2 },
  { id: 'claude-haiku-4-5', label: 'claude-haiku-4-5', weight: 3 },
];

const MEMBERS = [
  { id: 'u1', name: 'Alice Chen', email: 'alice@acme.dev', weight: 6 },
  { id: 'u2', name: 'Bob Martinez', email: 'bob@acme.dev', weight: 4 },
  { id: 'u3', name: 'Carol Singh', email: 'carol@acme.dev', weight: 3 },
  { id: 'u4', name: 'Dave Kim', email: 'dave@acme.dev', weight: 2 },
  { id: 'u5', name: 'Eve Larsson', email: 'eve@acme.dev', weight: 1 },
];

const RANGE_BUCKETS: Record<SettingsUsageRange, number> = {
  day: 12,
  week: 7,
  month: 30,
  total: 365,
};

// A smooth-ish deterministic curve in [0.15, 1].
function wave(i: number, n: number, phase: number): number {
  const t = n <= 1 ? 0 : i / (n - 1);
  return 0.15 + 0.85 * (0.5 + 0.5 * Math.sin(t * Math.PI * 2.2 + phase));
}

function labelFor(range: SettingsUsageRange, i: number, n: number): string {
  if (range === 'day') {
    const hour = ((i * 2 + 2) % 24).toString().padStart(2, '0');
    return `${hour}:00`;
  }
  // day-of relative labels for week/month/total
  const daysAgo = n - 1 - i;
  if (daysAgo === 0) return 'Today';
  return `-${daysAgo}d`;
}

function buildTimeline(range: SettingsUsageRange) {
  const n = RANGE_BUCKETS[range];
  const byModelBuckets: StackedAreaBucket[] = [];
  const byMemberBuckets: StackedAreaBucket[] = [];
  let totalTokens = 0;

  for (let i = 0; i < n; i += 1) {
    const label = labelFor(range, i, n);
    const scale = 40_000 * wave(i, n, 0.6);

    byModelBuckets.push({
      label,
      values: MODELS.map((m, mi) => {
        const value = Math.round(scale * m.weight * wave(i, n, mi * 1.3) * 0.05);
        totalTokens += value;
        return { id: m.id, label: m.label, value };
      }),
    });

    byMemberBuckets.push({
      label,
      values: MEMBERS.map((u, ui) => {
        const value = Math.round(scale * u.weight * wave(i, n, ui * 1.7 + 0.4) * 0.05);
        return { id: u.id, label: u.name, value };
      }),
    });
  }

  return {
    byModelBuckets,
    byMemberBuckets,
    totals: { tokens: totalTokens, costUSD: totalTokens * 0.000012 },
  };
}

function Harness({
  empty = false,
  loading = false,
  noWorkspace = false,
  initialRange = 'day',
}: {
  empty?: boolean;
  loading?: boolean;
  noWorkspace?: boolean;
  initialRange?: SettingsUsageRange;
}) {
  const [range, setRange] = useState<SettingsUsageRange>(initialRange);
  const data = useMemo(() => buildTimeline(range), [range]);

  const ready = !empty && !loading && !noWorkspace;

  return (
    <div className="mx-auto max-w-4xl">
      <StatsSettingsView
        workspaceName="Acme Robotics"
        range={range}
        onRangeChange={setRange}
        ready={ready}
        totals={ready ? data.totals : empty ? { tokens: 0, costUSD: 0 } : null}
        byModelBuckets={ready ? data.byModelBuckets : []}
        byMemberBuckets={ready ? data.byMemberBuckets : []}
        workspaceId={noWorkspace ? null : 'ws_1'}
        loading={loading}
      />
    </div>
  );
}

const meta: Meta<typeof Harness> = {
  title: 'Settings/StatsSettings',
  component: Harness,
  parameters: { layout: 'padded' },
};
export default meta;

type Story = StoryObj<typeof Harness>;

export const Default: Story = { args: {} };
export const LongRange: Story = { args: { initialRange: 'total' } };
export const Loading: Story = { args: { loading: true } };
export const Empty: Story = { args: { empty: true } };
export const NoWorkspace: Story = { args: { noWorkspace: true } };
