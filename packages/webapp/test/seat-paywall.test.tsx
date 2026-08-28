import type { OrgUsageResponse } from '@blitzos/schema';
import { describe, expect, it, vi } from 'vitest';
import { ApiRequestError, type ControlPlaneClient } from '../src/api.js';
import { InvitesPanel } from '../src/settings/InvitesPanel.js';
import { render, settle } from './dom.js';

/** Only what this panel calls. The panel takes the whole client, but a stub
 * that lists seventy unused methods hides which four matter here. */
function client(overrides: Partial<ControlPlaneClient> = {}): ControlPlaneClient {
  return {
    listInvites: vi.fn(async () => ({ invites: [], ttlDays: 14 })),
    createInvite: vi.fn(async () => { throw new Error('unused'); }),
    revokeInvite: vi.fn(async () => undefined),
    orgUsage: vi.fn(async (): Promise<OrgUsageResponse> => ({
      seatsUsed: 1,
      seatLimit: null,
      vmsUsed: 0,
      vmLimit: 10,
      platformCompute: false,
    })),
    billing: vi.fn(async () => { throw new Error('unused'); }),
    ...overrides,
  } as unknown as ControlPlaneClient;
}

function text(container: HTMLElement): string {
  return container.textContent ?? '';
}

async function submit(container: HTMLElement): Promise<void> {
  container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await settle();
}

describe('the seat paywall', () => {
  it('shows no seat counter where no billing service is attached', async () => {
    const view = await render(<InvitesPanel client={client()} />);
    await settle();
    expect(view.container.querySelector('.settings-seats')).toBeNull();
    await view.unmount();
  });

  it('counts the seats in use against the cap', async () => {
    const view = await render(<InvitesPanel client={client({
      orgUsage: vi.fn(async () => ({ seatsUsed: 2, seatLimit: 3, vmsUsed: 0, vmLimit: 10, platformCompute: false })),
    })} />);
    await settle();
    expect(text(view.container)).toContain('2');
    expect(text(view.container)).toContain('3');
    // One control, one word, whichever side of the limit the organization is
    // on. The billing service decides what it opens.
    expect(text(view.container)).toContain('Manage');
    expect(text(view.container)).not.toContain('Upgrade');
    await view.unmount();
  });

  it('keeps the same control when the seats are full', async () => {
    const billing = vi.fn(async () => ({ url: 'https://billing.example/checkout#token=abc' }));
    const view = await render(<InvitesPanel client={client({
      billing,
      orgUsage: vi.fn(async () => ({ seatsUsed: 1, seatLimit: 1, vmsUsed: 0, vmLimit: 10, platformCompute: false })),
    })} />);
    await settle();

    const control = view.container.querySelector('.settings-seats button');
    expect(control?.textContent).toBe('Manage');
    // Emphasis changes with the limit; the word and the destination do not.
    expect(control?.className).toContain('webapp-action--primary');
    await view.unmount();
  });

  it('turns the seat refusal into an offer, counting the buyer own seat', async () => {
    const createInvite = vi.fn(async () => {
      throw new ApiRequestError(
        'seat limit reached',
        402,
        'upgrade',
        'https://billing.example/checkout#token=abc',
      );
    });
    const view = await render(<InvitesPanel client={client({
      createInvite,
      orgUsage: vi.fn(async () => ({ seatsUsed: 1, seatLimit: 1, vmsUsed: 0, vmLimit: 10, platformCompute: false })),
    })} />);
    await settle();
    await submit(view.container);

    const offer = view.container.querySelector('.settings-paywall');
    expect(offer).not.toBeNull();
    // One person inviting their second buys two seats, not one.
    expect(text(view.container)).toContain('Buy 2 seats');
    expect(text(view.container)).toContain('$200 per month');
    expect(view.container.querySelector('.settings-paywall a')?.getAttribute('href'))
      .toBe('https://billing.example/checkout#token=abc');
    // The bare string is what a person used to get instead.
    expect(view.container.querySelector('.webapp-form-message')).toBeNull();
    await view.unmount();
  });

  it('still prints an error that carries no way out', async () => {
    const createInvite = vi.fn(async () => {
      throw new ApiRequestError('organization admin required', 403, null);
    });
    const view = await render(<InvitesPanel client={client({ createInvite })} />);
    await settle();
    await submit(view.container);

    expect(view.container.querySelector('.settings-paywall')).toBeNull();
    expect(text(view.container)).toContain('organization admin required');
    await view.unmount();
  });
});
