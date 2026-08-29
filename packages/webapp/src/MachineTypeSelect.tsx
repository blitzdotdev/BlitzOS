import type { MachineType } from '@blitzos/schema';
import { groupMachineTypes, monthlyPriceLabel } from './MachineCatalogGrid';
import { WebAppSelectMenu, type CockpitSelectOption } from './WebAppSelectMenu';

/** The value that means "no per-member override": the machine takes whatever
 * the workspace default is at provision time (plans/MEMBER-MACHINES.md §1a).
 * Empty string, so a row that never chose sends nothing. */
export const WORKSPACE_DEFAULT_MACHINE_TYPE = '';

/** A provider attaches a volume only inside its own location, so a live
 * machine can only move to a type in the volume's location (§1a, §5). */
function locationOf(machine: MachineType): string {
  return machine.location || machine.id.split('@').at(-1) || '';
}

function optionDescription(machine: MachineType): string {
  const price = monthlyPriceLabel(machine.monthlyPrice);
  const spec = `${String(machine.cpuCores)} vCPU · ${String(machine.memGb)} GB RAM`;
  return price === null ? spec : `${spec} · ${price}`;
}

/**
 * The compact per-member machine-type picker (plan §6b, new component 1).
 *
 * `MachineCatalogGrid` stays the picker for the workspace default — a grid of
 * radio cards is right when the choice is the point of the screen. This is the
 * same catalog, grouped the same way, in a control that fits a member row.
 *
 * `volumeLocation` turns it into the `SetMachineType` picker: types outside
 * that location stay visible and go disabled, because a member who cannot find
 * their type assumes a bug, and one who reads "the volume is in fsn1" does not.
 */
export function MachineTypeSelect({
  machines,
  value,
  defaultMachineTypeId,
  volumeLocation = null,
  ariaLabel,
  disabled = false,
  onChange,
}: {
  machines: readonly MachineType[];
  /** A machine type id, or `WORKSPACE_DEFAULT_MACHINE_TYPE`. */
  value: string;
  /** Named in the first option, so a row shows what "default" resolves to. */
  defaultMachineTypeId: string;
  /** The volume's location on a live machine; null before one exists. */
  volumeLocation?: string | null;
  ariaLabel: string;
  disabled?: boolean;
  onChange: (machineTypeId: string) => void;
}) {
  const defaultMachine = machines.find(({ id }) => id === defaultMachineTypeId);
  const options: CockpitSelectOption[] = [{
    value: WORKSPACE_DEFAULT_MACHINE_TYPE,
    label: `Workspace default (${defaultMachine?.name || defaultMachineTypeId})`,
    description: defaultMachine === undefined ? undefined : optionDescription(defaultMachine),
  }];
  for (const group of groupMachineTypes(machines)) {
    for (const machine of group.machines) {
      const elsewhere = volumeLocation !== null && locationOf(machine) !== volumeLocation;
      options.push({
        value: machine.id,
        label: machine.name || machine.id,
        group: group.label,
        description: elsewhere
          ? `the volume is in ${volumeLocation}`
          : optionDescription(machine),
        disabled: elsewhere,
      });
    }
  }
  return (
    <WebAppSelectMenu
      ariaLabel={ariaLabel}
      className="machine-type-select"
      value={value}
      options={options}
      disabled={disabled}
      onChange={onChange}
    />
  );
}
