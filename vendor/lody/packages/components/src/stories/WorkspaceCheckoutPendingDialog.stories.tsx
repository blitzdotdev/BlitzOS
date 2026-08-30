import type { Meta, StoryObj } from '@storybook/react';

import { WorkspaceCheckoutPendingDialogView } from '@/components/workspace-checkout-pending-dialog';

const meta = {
  title: 'Workspace/WorkspaceCheckoutPendingDialog',
  component: WorkspaceCheckoutPendingDialogView,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  args: {
    onDismiss: () => {},
    onGoToCheckout: () => {},
  },
} satisfies Meta<typeof WorkspaceCheckoutPendingDialogView>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Admin view: can jump straight to checkout. */
export const AdminCanPay: Story = {
  args: {
    canManageBilling: true,
  },
};

/** Regular member: informational only, must ask an admin to pay. */
export const MemberWaitingOnAdmin: Story = {
  args: {
    canManageBilling: false,
  },
};
