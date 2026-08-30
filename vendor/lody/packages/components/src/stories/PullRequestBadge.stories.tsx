import type { Meta, StoryObj } from '@storybook/react';
import type { SessionPullRequestMetaWithLegacy } from '@lody/shared';
import { PullRequestBadge } from '@/components/sessions/pull-request-badge';

const basePr: SessionPullRequestMetaWithLegacy = {
  url: '#',
  number: 42,
  status: 'open',
  branch: 'feat/cool-feature',
  reportedAt: new Date().toISOString(),
};

const variants: Array<{ label: string; pr: SessionPullRequestMetaWithLegacy }> = [
  { label: 'Open', pr: { ...basePr } },
  { label: 'Draft', pr: { ...basePr, status: 'draft' } },
  { label: 'Closed', pr: { ...basePr, status: 'closed' } },
  { label: 'Merged', pr: { ...basePr, status: 'merged' } },
];

function AllVariants() {
  return (
    <div className="grid gap-6 text-foreground">
      {/* Normal size */}
      <div>
        <h3 className="text-sm font-semibold text-muted-foreground mb-3">Normal (md)</h3>
        <div className="flex flex-wrap gap-3">
          {variants.map(({ label, pr }) => (
            <div key={label} className="flex flex-col items-center gap-2">
              <PullRequestBadge pr={pr} />
              <span className="text-[10px] text-muted-foreground">{label}</span>
            </div>
          ))}
        </div>
      </div>
      {/* Large preview — icon scaled up to see detail */}
      <div>
        <h3 className="text-sm font-semibold text-muted-foreground mb-3">Zoomed (48px icons)</h3>
        <div className="flex flex-wrap gap-6">
          {variants.map(({ label, pr }) => (
            <div key={`lg-${label}`} className="flex flex-col items-center gap-2">
              <PullRequestBadge
                pr={pr}
                size="md"
                className="text-base [&_svg]:h-12 [&_svg]:w-12 px-3 py-2"
              />
              <span className="text-xs text-muted-foreground">{label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const meta = {
  title: 'Sessions/PullRequestBadge',
  component: PullRequestBadge,
  parameters: {
    layout: 'centered',
  },
} satisfies Meta<typeof PullRequestBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AllStates: Story = {
  args: { pr: basePr },
  render: () => <AllVariants />,
};
