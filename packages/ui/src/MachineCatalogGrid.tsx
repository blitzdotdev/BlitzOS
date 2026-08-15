import type { MachineType } from '@blitzos/schema';

export function machineTypeLabel(typeId: string): string {
  return typeId;
}

function machineGroup(machine: MachineType): string {
  const location = machine.location || machine.id.split('@').at(-1) || 'unknown';
  return machine.id.startsWith('mv-') || location === 'lab'
    ? 'Local lab'
    : `Hetzner · ${location}`;
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
