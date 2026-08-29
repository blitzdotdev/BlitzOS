import { describe, expect, it } from 'vitest';
import { type MachineId, type MachineMeta } from '@lody/shared';
import { formatMachineCli, sortMachineMetas, toMachineJsonEntry } from './machine';

const createMachine = (overrides: Partial<MachineMeta> = {}): MachineMeta => ({
  id: 'machine-id',
  name: 'Machine',
  cliVersion: '0.0.0',
  os: 'linux',
  sessions: [],
  ...overrides,
});

describe('machine command helpers', () => {
  it('sorts machines by presence-online state, current machine, then name', () => {
    const machines = [
      createMachine({ id: 'machine-2', name: 'Beta' }),
      createMachine({ id: 'machine-3', name: 'Gamma' }),
      createMachine({ id: 'machine-1', name: 'Alpha' }),
    ];
    const onlineMachineIds = new Set<MachineId>([
      'machine-1' as MachineId,
      'machine-3' as MachineId,
    ]);

    expect(
      sortMachineMetas(machines, onlineMachineIds, 'machine-1').map((machine) => machine.id)
    ).toEqual(['machine-1', 'machine-3', 'machine-2']);
  });

  it('formats registry cli names into one column', () => {
    expect(
      formatMachineCli(
        createMachine({
          supportRegistryAgentTypes: ['opencode', 'codex', 'kimi'],
        })
      )
    ).toBe('opencode,codex,kimi');

    expect(formatMachineCli(createMachine())).toBe('-');
  });

  it('omits acpCapabilities from json output unless explicitly requested', () => {
    const machine = {
      ...createMachine(),
      acpCapabilities: {
        'registry:opencode': {
          agentType: 'opencode',
          cliType: 'registry',
          fetchedAt: 1,
          models: [],
          modes: [],
        },
      },
      raceLimits: {},
      online: true,
    };

    expect(
      toMachineJsonEntry(machine, { includeAcpCapabilities: false, includeAgents: false })
    ).not.toHaveProperty('acpCapabilities');
    expect(
      toMachineJsonEntry(machine, { includeAcpCapabilities: true, includeAgents: false })
    ).toHaveProperty('acpCapabilities');
  });

  it('omits agent configs from json output unless explicitly requested', () => {
    const machine = {
      ...createMachine(),
      raceLimits: {},
      online: true,
      agentConfigs: [
        {
          id: 'agent-config-id',
          machineId: 'machine-id',
          name: 'Codex',
          cliType: 'builtin',
          agentType: 'codex',
          env: {},
        },
      ],
    };

    expect(
      toMachineJsonEntry(machine, { includeAcpCapabilities: false, includeAgents: false })
    ).not.toHaveProperty('agentConfigs');
    expect(
      toMachineJsonEntry(machine, { includeAcpCapabilities: false, includeAgents: true })
    ).toHaveProperty('agentConfigs');
  });
});
