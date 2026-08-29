import type { Meta, StoryObj } from '@storybook/react';

import { ProposedPlanBlock } from '@/components/ai-gui/view';

const meta = {
  title: 'AI GUI/ProposedPlanBlock',
  component: ProposedPlanBlock,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof ProposedPlanBlock>;

export default meta;
type Story = StoryObj<typeof meta>;

const sampleMarkdown = `## Goal

Add a copy button to the Proposed Plan block so users can copy the plan text.

## Steps

1. Add a \`didCopy\` state and a \`handleCopy\` callback that writes \`plan.markdown\` to the clipboard.
2. Render a ghost icon button in the header next to the status badge.
3. Toggle the icon between **Copy** and **Check** for 1.2s on success.

## Files

- \`packages/components/src/components/ai-gui/view.tsx\`
`;

export const Ready: Story = {
  args: {
    plan: {
      type: 'proposed_plan',
      turnId: 'turn-1',
      markdown: sampleMarkdown,
      status: 'completed',
      isLatest: true,
    },
    messageId: 'msg-1',
    itemIndex: 0,
  },
  render: (args) => (
    <div className="w-[520px] max-w-[calc(100vw-2rem)]">
      <ProposedPlanBlock {...args} />
    </div>
  ),
};

export const Drafting: Story = {
  args: {
    plan: {
      type: 'proposed_plan',
      turnId: 'turn-1',
      markdown: sampleMarkdown,
      status: 'delta',
      isLatest: true,
    },
    messageId: 'msg-2',
    itemIndex: 0,
  },
  render: (args) => (
    <div className="w-[520px] max-w-[calc(100vw-2rem)]">
      <ProposedPlanBlock {...args} />
    </div>
  ),
};
