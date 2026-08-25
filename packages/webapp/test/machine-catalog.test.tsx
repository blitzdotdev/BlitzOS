import { describe, expect, it } from 'vitest';
import type { MachineType } from '@blitzos/schema';
import { MachineCatalogGrid } from '../src/MachineCatalogGrid.js';
import { render } from './dom.js';

const HETZNER: MachineType = {
  id: 'cx23@hel1',
  providerId: 'hetzner',
  supportsVolumes: true,
  name: 'CX23',
  cpuCores: 2,
  memGb: 4,
  diskGb: 40,
  arch: 'x86',
  location: 'hel1',
  monthlyPrice: { amount: 6.49, currency: 'EUR' },
};

// The microVM pool publishes no price, so its card carries none.
const LAB: MachineType = {
  id: 'mv-2c2g@lab',
  providerId: 'microvm',
  supportsVolumes: false,
  name: 'Lab 2C/2G',
  cpuCores: 2,
  memGb: 2,
  diskGb: 20,
  arch: 'x86',
  location: 'lab',
};

function card(container: HTMLElement, machineTypeId: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>('.blueprint-machine-card')].find(
    (node) => node.querySelector<HTMLInputElement>('input')?.value === machineTypeId,
  );
  if (found === undefined) throw new Error(`no card for ${machineTypeId}`);
  return found;
}

async function catalog() {
  return render(
    <MachineCatalogGrid
      machines={[HETZNER, LAB]}
      selectedMachineType=""
      onSelect={() => undefined}
    />,
  );
}

describe('machine catalog grid', () => {
  it('prints the monthly price last in the priced card, so it sits bottom right', async () => {
    const view = await catalog();
    const facts = card(view.container, 'cx23@hel1').querySelector('.blueprint-machine-facts');

    expect(facts?.lastElementChild?.className).toBe('blueprint-machine-price');
    expect(facts?.lastElementChild?.textContent).toBe('€6.49/mo');
    await view.unmount();
  });

  it('prints no price for a machine the provider does not price', async () => {
    const view = await catalog();
    const lab = card(view.container, 'mv-2c2g@lab');

    expect(lab.querySelector('.blueprint-machine-price')).toBeNull();
    // The rest of the card must still read the same.
    expect(lab.textContent).toContain('Lab 2C/2G');
    expect(lab.textContent).toContain('2 vCPU · 2 GB RAM · 20 GB disk');
    expect(lab.querySelector('.blueprint-machine-facts')?.textContent).toBe('x86lab');
    await view.unmount();
  });
});
