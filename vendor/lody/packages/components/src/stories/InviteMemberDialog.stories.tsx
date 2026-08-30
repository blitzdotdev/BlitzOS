import type { Meta, StoryObj } from '@storybook/react';
import {
  InviteMemberDialog,
  type SeatInvitePreview,
} from '@/components/settings/invite-member-dialog';

const monthlySeatPreview: SeatInvitePreview = {
  status: 'billed',
  interval: 'month',
  unitAmount: 1000,
  proratedAmount: 581,
  currentPeriodEnd: new Date('2026-08-28T00:00:00Z').getTime(),
  seatCount: 3,
  nextSeatCount: 4,
  nextRenewalAmount: 4000,
};

const yearlySeatPreview: SeatInvitePreview = {
  status: 'billed',
  interval: 'year',
  unitAmount: 9600,
  proratedAmount: 3120,
  currentPeriodEnd: new Date('2027-02-14T00:00:00Z').getTime(),
  seatCount: 5,
  nextSeatCount: 6,
  nextRenewalAmount: 57600,
};

const meta = {
  title: 'Settings/InviteMemberDialog',
  component: InviteMemberDialog,
  parameters: { layout: 'centered' },
  args: {
    open: true,
    onOpenChange: () => {},
    workspaceName: 'Acme Corp',
    hasAdminPermission: true,
    onInvite: () => {},
    onOpenBilling: () => {},
  },
} satisfies Meta<typeof InviteMemberDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Paid monthly workspace: the added seat is quoted before the invite is sent. */
export const PaidMonthly: Story = {
  args: { seatPreview: monthlySeatPreview },
};

export const PaidYearly: Story = {
  args: { seatPreview: yearlySeatPreview },
};

/** Free workspace under the member limit: no seat billing, so no cost block. */
export const FreeWorkspace: Story = {
  args: { seatPreview: { status: 'not_billed', reason: 'free' } },
};

/** Gift or enterprise entitlement: members are not billed per seat. */
export const CoveredPlan: Story = {
  args: { seatPreview: { status: 'not_billed', reason: 'covered' } },
};

/** Seat preview still loading; the cost block holds its place. */
export const LoadingSeatCost: Story = {
  args: { seatPreview: undefined },
};

/** Billing period unknown, so the charge is described without a number. */
export const UnknownProration: Story = {
  args: {
    seatPreview: { ...monthlySeatPreview, proratedAmount: null },
  },
};

export const FreeLimitReached: Story = {
  args: {
    memberLimit: 3,
    memberLimitReached: true,
    seatPreview: { status: 'not_billed', reason: 'free' },
  },
};

export const Sending: Story = {
  args: { seatPreview: monthlySeatPreview, inviting: true },
};

export const DarkMode: Story = {
  globals: { theme: 'dark' },
  args: { seatPreview: monthlySeatPreview },
};

export const DarkModeLimitReached: Story = {
  globals: { theme: 'dark' },
  args: { memberLimit: 3, memberLimitReached: true },
};
