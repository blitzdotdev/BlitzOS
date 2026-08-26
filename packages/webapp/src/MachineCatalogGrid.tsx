import type { MachinePrice, MachineType } from '@blitzos/schema';

export function machineTypeLabel(typeId: string): string {
  return typeId;
}

/** Intl.NumberFormat throws RangeError unless the currency is exactly three
 * ASCII letters. The code comes from a vendor over the network, so one bad
 * code would throw inside the map and blank the whole grid. */
const CURRENCY_CODE_PATTERN = /^[A-Za-z]{3}$/u;

/**
 * Writes the price the way a card corner can hold it, for example "$6.49/mo".
 * The card prints the currency it was given, never one it assumed.
 *
 * Null means the card shows no price. That happens three ways: the provider
 * declared none, the code is not a currency code, or the field never arrived.
 * The last one is real: the wire type requires the field, but this JSON comes
 * from a control plane that deploys on its own clock, and a throw inside the
 * card map would blank the whole grid.
 *
 * The locale stays pinned to en-US, like the chat date format, because the
 * whole dialog is English.
 */
function monthlyPriceLabel(price: MachinePrice | null | undefined): string | null {
  if (price === null || price === undefined) return null;
  if (!CURRENCY_CODE_PATTERN.test(price.currency)) return null;
  const amount = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: price.currency,
  }).format(price.amount);
  return `${amount}/mo`;
}

function machineGroup(machine: MachineType): string {
  const location = machine.location || machine.id.split('@').at(-1) || 'unknown';
  if (machine.providerId === 'microvm') return 'Local lab';
  if (machine.providerId === 'hetzner') return `Hetzner · ${location}`;
  return `${machine.providerId} · ${location}`;
}

export function groupMachineTypes(machines: readonly MachineType[]): Array<{
  label: string;
  machines: MachineType[];
}> {
  const groups = new Map<string, MachineType[]>();
  for (const machine of machines) {
    const label = machineGroup(machine);
    const group = groups.get(label) ?? [];
    group.push(machine);
    groups.set(label, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, groupedMachines]) => ({
      label,
      machines: groupedMachines.sort((left, right) => (
        left.cpuCores - right.cpuCores
        || left.memGb - right.memGb
        || left.id.localeCompare(right.id)
      )),
    }));
}

export function MachineCatalogGrid({
  machines,
  selectedMachineType,
  onSelect,
}: {
  machines: readonly MachineType[];
  selectedMachineType: string;
  onSelect: (machineType: string) => void;
}) {
  return (
    <div className="machine-catalog-groups">
      {groupMachineTypes(machines).map((group) => (
        <section className="machine-catalog-group" key={group.label}>
          <h3>{group.label}</h3>
          <div className="blueprint-machine-grid" role="radiogroup" aria-label={`${group.label} machine type`}>
            {group.machines.map((machine) => {
              const selected = selectedMachineType === machine.id;
              const priceLabel = monthlyPriceLabel(machine.monthlyPrice);
              return (
                <label
                  className={`blueprint-machine-card${selected ? ' blueprint-machine-card--selected' : ''}`}
                  key={machine.id}
                >
                  <input
                    type="radio"
                    name="machineTypeId"
                    value={machine.id}
                    checked={selected}
                    onChange={() => onSelect(machine.id)}
                  />
                  <span className="blueprint-machine-copy">
                    {selected && <span className="blueprint-machine-check" aria-hidden="true">✓</span>}
                    <span className="blueprint-machine-name">{machine.name || machine.id}</span>
                    <span className="blueprint-machine-spec">
                      {machine.cpuCores} vCPU · {machine.memGb} GB RAM · {machine.diskGb} GB disk
                    </span>
                  </span>
                  <span className="blueprint-machine-facts">
                    <span>{machine.arch}</span>
                    <span className="blueprint-machine-os">
                      <span className="mi-ubuntu" aria-hidden="true" />
                      {machine.location}
                    </span>
                    {/* Last in the facts row, so the price lands in the bottom
                      * right corner. A machine with no price adds no node, so
                      * the other facts keep their places. */}
                    {priceLabel !== null && (
                      <span className="blueprint-machine-price">
                        {priceLabel}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
