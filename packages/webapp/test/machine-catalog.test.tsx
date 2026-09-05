import { describe, expect, it } from 'vitest';
import type { MachineType } from '@blitzos/schema';
import { MachineCatalogGrid } from '../src/MachineCatalogGrid.js';
import { render } from './dom.js';

function machine(over: Partial<MachineType>): MachineType {
  return {
    id: 'cx23@hel1',
    providerId: 'hetzner',
    supportsVolumes: true,
    name: 'CX23',
    cpuCores: 2,
    memGb: 4,
    diskGb: 40,
    arch: 'x86',
    location: 'hel1',
    monthlyPrice: null,
    standsInFor: null,
    ...over,
  };
}

// Hetzner bills this account in dollars. The card printed "€6.49/mo" for it
// until the provider stopped assuming a currency.
const DOLLARS = machine({ monthlyPrice: { amount: 6.49, currency: 'USD' } });

// A Hetzner account billed in euro must still see euro.
const EUROS = machine({
  id: 'cx33@hel1',
  name: 'CX33',
  monthlyPrice: { amount: 9.99, currency: 'EUR' },
});

// A provider may omit a price, so its card carries none.
const UNPRICED = machine({
  id: 'aws-t3.medium@us-east-1',
  providerId: 'aws',
  name: 't3.medium',
  memGb: 4,
  diskGb: 40,
  location: 'us-east-1',
});

function card(container: HTMLElement, machineTypeId: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>('.blueprint-machine-card')].find(
    (node) => node.querySelector<HTMLInputElement>('input')?.value === machineTypeId,
  );
  if (found === undefined) throw new Error(`no card for ${machineTypeId}`);
  return found;
}

function priceOf(container: HTMLElement, machineTypeId: string): string | null {
  return card(container, machineTypeId).querySelector('.blueprint-machine-price')?.textContent
    ?? null;
}

async function catalog(machines: readonly MachineType[]) {
  return render(
    <MachineCatalogGrid
      machines={machines}
      selectedMachineType=""
      onSelect={() => undefined}
    />,
  );
}

describe('machine catalog grid', () => {
  it('prints each price in the currency that machine was given', async () => {
    const view = await catalog([DOLLARS, EUROS]);

    expect(priceOf(view.container, 'cx23@hel1')).toBe('$6.49/mo');
    expect(priceOf(view.container, 'cx33@hel1')).toBe('€9.99/mo');
    await view.unmount();
  });

  it('prints the monthly price last in the priced card, so it sits bottom right', async () => {
    const view = await catalog([DOLLARS, UNPRICED]);
    const facts = card(view.container, 'cx23@hel1').querySelector('.blueprint-machine-facts');

    expect(facts?.lastElementChild?.className).toBe('blueprint-machine-price');
    expect(facts?.lastElementChild?.textContent).toBe('$6.49/mo');
    await view.unmount();
  });

  it('prints no price for a machine the provider declares no price for', async () => {
    const view = await catalog([DOLLARS, UNPRICED]);
    const unpriced = card(view.container, 'aws-t3.medium@us-east-1');

    expect(unpriced.querySelector('.blueprint-machine-price')).toBeNull();
    // The rest of the card must still read the same.
    expect(unpriced.textContent).toContain('t3.medium');
    expect(unpriced.textContent).toContain('2 vCPU · 4 GB RAM · 40 GB disk');
    expect(unpriced.querySelector('.blueprint-machine-facts')?.textContent).toBe('x86us-east-1');
    await view.unmount();
  });

  it('survives a control plane that sends no price field at all', async () => {
    // The wire type requires the field. The control plane still deploys on its
    // own clock, so an older one can answer without it. Reading `.currency`
    // off that would throw inside the card map and blank every card.
    // JSON.stringify drops the undefined key, so this is byte for byte the
    // payload an older control plane sends.
    // SAFETY: parsed JSON is typed as the wire type here, exactly as the API
    // client does it. The point of the test is that the wire type cannot
    // police what really arrives.
    const legacy = JSON.parse(
      JSON.stringify({ ...DOLLARS, id: 'cx13@hel1', monthlyPrice: undefined }),
    ) as MachineType;

    const view = await catalog([legacy, DOLLARS]);

    expect(priceOf(view.container, 'cx13@hel1')).toBeNull();
    expect(priceOf(view.container, 'cx23@hel1')).toBe('$6.49/mo');
    await view.unmount();
  });

  it('drops a malformed currency code instead of throwing away the grid', async () => {
    // Intl.NumberFormat throws RangeError on any code that is not three ASCII
    // letters. Thrown inside the map, it would blank every card.
    const broken = machine({
      id: 'cpx21@hil',
      name: 'CPX21',
      location: 'hil',
      monthlyPrice: { amount: 37.49, currency: 'EURO' },
    });

    const view = await catalog([DOLLARS, broken, UNPRICED]);

    expect(priceOf(view.container, 'cpx21@hil')).toBeNull();
    expect(card(view.container, 'cpx21@hil').textContent).toContain('CPX21');
    // The other cards keep their prices, so one bad code costs one label.
    expect(priceOf(view.container, 'cx23@hel1')).toBe('$6.49/mo');
    expect(priceOf(view.container, 'aws-t3.medium@us-east-1')).toBeNull();
    await view.unmount();
  });

  it('says which sold-out entry a stand-in card replaces', async () => {
    // Hetzner had cx33 sold out in hel1 on 2026-09-05, so the page offers
    // cpx32 there instead. It costs four times as much, so the card must say
    // why rather than leave the jump unexplained.
    const standIn = machine({
      id: 'cpx32@hel1',
      name: 'CPX32',
      cpuCores: 4,
      memGb: 8,
      diskGb: 160,
      monthlyPrice: { amount: 41.99, currency: 'USD' },
      standsInFor: 'cx33',
    });

    const view = await catalog([DOLLARS, standIn]);

    expect(card(view.container, 'cpx32@hel1').querySelector('.blueprint-machine-standin')
      ?.textContent).toBe('stands in for cx33, sold out in hel1');
    // A machine offered in its own right carries no such line.
    expect(card(view.container, 'cx23@hel1').querySelector('.blueprint-machine-standin'))
      .toBeNull();
    await view.unmount();
  });

  it('survives a control plane that sends no stand-in field at all', async () => {
    // Same reason as the price field above: the control plane deploys on its
    // own clock, so an older one answers without the key.
    // SAFETY: parsed JSON is typed as the wire type here, exactly as the API
    // client does it.
    const legacy = JSON.parse(
      JSON.stringify({ ...DOLLARS, standsInFor: undefined }),
    ) as MachineType;

    const view = await catalog([legacy]);

    expect(card(view.container, 'cx23@hel1').querySelector('.blueprint-machine-standin'))
      .toBeNull();
    await view.unmount();
  });
});
