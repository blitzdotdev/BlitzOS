import { useEffect, useRef, useState } from 'react';
import type {
  ListMachineTypesResponse,
  MachineType,
  MachineView,
  WorkspaceMemberView,
} from '@blitzos/schema';
import type { ControlPlaneClient } from './api';
import { caughtErrorMessage } from './error-message';
import { ConfirmationDialog } from './ConfirmationDialog';
import { monthlyPriceLabel } from './MachineCatalogGrid';
import { MachineTypeSelect } from './MachineTypeSelect';
import { ModalOverlay } from './ModalOverlay';
import { VolumeMeter } from './VolumeMeter';
import {
  machineActionsFor,
  machinePendingLabel,
  type MachineAction,
} from './WorkspaceMembersEditor';
import type { CloudWorkspaceModel, WorkspaceAction } from './workspace-store';
import { useErrorReporter } from './error-dialog/ErrorReporter';
import {
  type MachineOverlay,
  runMachineOverlayAction,
} from './machine-overlay';

const ACTION_LABELS = {
  provision: 'Provision',
  stop: 'Stop',
  start: 'Start',
  recreate: 'Recreate',
  destroy: 'Destroy',
} satisfies Record<MachineAction, string>;

/**
 * Who may run each verb on their OWN machine (plans/MEMBER-MACHINES.md §3).
 *
 * `stop` and `start` are a member's own business, and so is bringing a machine
 * row that exists back up. Replacing, destroying and re-typing a machine
 * interrupt work and belong to a workspace admin — as does provisioning where
 * there is no machine row at all, which is the member-add route in disguise.
 */
function needsAdmin(action: MachineAction, machine: MachineView | null): boolean {
  if (action === 'stop' || action === 'start') return false;
  if (action === 'provision') return machine === null;
  return true;
}

function dateLabel(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'Unavailable';
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp));
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

/** The empty catalog, before the first answer arrives. */
const NO_CATALOG: ListMachineTypesResponse = { machineTypes: [], failures: [] };

/**
 * Why the catalog cannot describe this machine's type.
 *
 * `GET /machine-types` is what an organization may create NOW, not what its
 * machines run on: the Hetzner adapter drops deprecated types, drops locations
 * that report no availability, and keeps only the ids in
 * `HETZNER_MACHINE_TYPES`, while `core/app.ts` drops whole providers whose
 * access is `credential-required`. A live machine on a type that has since
 * left the catalog is normal and documented (`hetzner-config.ts`), and it is
 * what this panel used to render as four bare "Unavailable" rows.
 *
 * The same response carries the reason in `failures` and `providerStatuses`,
 * which this dialog used to discard. `CreateWorkspaceDialog` reads both.
 */
function catalogGap(
  catalog: ListMachineTypesResponse,
  machineTypeId: string,
): string {
  if (catalog.failures.length > 0) {
    const listed = catalog.failures
      .map(({ providerId, error }) => `${providerId}: ${error}`)
      .join('; ');
    return `The machine catalog came back incomplete (${listed}), so the size of ${machineTypeId} cannot be shown. The machine itself is unaffected.`;
  }
  const needCredential = (catalog.providerStatuses ?? [])
    .filter(({ access }) => access === 'credential-required')
    .map(({ providerId }) => providerId);
  if (needCredential.length > 0) {
    return `Machine sizes come from the compute provider, and ${needCredential.join(', ')} needs an organization compute credential, so the size of ${machineTypeId} cannot be shown. The machine itself is unaffected.`;
  }
  return `The catalog no longer offers ${machineTypeId}, so this machine's size cannot be shown. The machine itself is unaffected.`;
}

/** The volume's location, so a type change can refuse what cannot reach it.
 * Derived from the machine's current type, because the volume was created in
 * that type's location. */
function volumeLocationOf(
  machine: MachineView | null,
  machines: readonly MachineType[],
): string | null {
  if (machine === null || machine.volumeId === null) return null;
  const current = machines.find(({ id }) => id === machine.machineTypeId);
  if (current === undefined) return null;
  return current.location || current.id.split('@').at(-1) || null;
}

/** The people to ask for what this member may not do themselves. This is the
 * whole of "request a change" for now: there is no request to file, so the
 * refusal names who can act instead of pretending somebody was told. */
function askLine(members: readonly WorkspaceMemberView[]): string {
  const admins = members.filter(({ role }) => role === 'admin').map(({ name }) => name);
  if (admins.length === 0) return 'Ask a workspace admin.';
  return `Ask a workspace admin: ${admins.join(', ')}`;
}

/**
 * The member's own machine, in the workspace-details chrome and without its
 * tab row: there is one thing to read here.
 *
 * Everything it shows already exists on the wire — the member row of
 * `WorkspaceView` carries the machine, and the catalog names its size. What it
 * adds is the §3 matrix in the first person: a verb this member may not run is
 * shown disabled with the admins to ask, rather than hidden or refused after
 * the click.
 */
export function MyMachineDialog({
  client,
  workspace,
  membershipId,
  listMachineTypes,
  commitWorkspaceMutation,
  onClose,
}: {
  client: ControlPlaneClient;
  workspace: CloudWorkspaceModel;
  /** The requesting member's membership, which is what keys a machine. */
  membershipId: string | null;
  listMachineTypes: () => Promise<ListMachineTypesResponse>;
  commitWorkspaceMutation: (action: WorkspaceAction) => void;
  onClose: () => void;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  // The WHOLE answer, not just its machine list: `failures` and
  // `providerStatuses` are what explain a catalog that cannot describe this
  // machine, and dropping them is what left the panel saying "Unavailable".
  const [catalog, setCatalog] = useState<ListMachineTypesResponse>(NO_CATALOG);
  const [error, setError] = useState<string | null>(null);
  const [pendingTypeId, setPendingTypeId] = useState<string | null>(null);
  const [machineOverlay, setMachineOverlay] = useState<MachineOverlay | null>(null);
  const reportError = useErrorReporter();
  const machines: MachineType[] = catalog.machineTypes;

  useEffect(() => { closeButton.current?.focus(); }, []);
  useEffect(() => {
    let cancelled = false;
    void listMachineTypes()
      .then((response) => { if (!cancelled) setCatalog(response); })
      // A rejection is not always an Error. Reading `.message` off one that is
      // not put `undefined` in the alert, which renders an empty banner.
      .catch((caught) => {
        if (!cancelled) {
          setError(caughtErrorMessage(caught, 'The machine catalog could not be loaded.'));
        }
      });
    return () => { cancelled = true; };
  }, [listMachineTypes]);

  const member = workspace.members.find((row) => row.membershipId === membershipId);
  const machine = machineOverlay?.machine ?? member?.machine ?? null;
  const pendingAction = machineOverlay?.pendingAction ?? null;

  // A workspace admin, or an org admin reaching in implicitly (§3).
  const admin = workspace.myRole === 'admin' || workspace.myRole === null;
  const type = machines.find(({ id }) => id === machine?.machineTypeId);
  const price = monthlyPriceLabel(type?.monthlyPrice);

  const runMachineAction = (
    action: MachineAction,
    request: () => Promise<MachineView | null>,
    title?: string,
  ) => {
    if (member === undefined) return;
    runMachineOverlayAction({
      action,
      machine,
      request,
      setOverlay: setMachineOverlay,
      commitWorkspaceMutation,
      workspaceId: workspace.id,
      membershipId: member.membershipId,
      reportError,
      errorAction: `Your machine in ${workspace.title}.`,
      title,
    });
  };

  const act = (action: MachineAction) => {
    if (machine === null) {
      if (action === 'provision') {
        runMachineAction(action, () => client.provisionMemberMachine(
          workspace.id,
          membershipId ?? '',
          {},
        ).then(({ member: updated }) => updated.machine));
      }
      return;
    }
    if (action === 'provision') runMachineAction(
      action,
      () => client.provisionMachine(machine.id).then(({ machine: updated }) => updated),
    );
    if (action === 'stop') runMachineAction(
      action,
      () => client.stopMachine(machine.id).then(({ machine: updated }) => updated),
    );
    if (action === 'start') runMachineAction(
      action,
      () => client.startMachine(machine.id).then(({ machine: updated }) => updated),
    );
    if (action === 'recreate') runMachineAction(
      action,
      () => client.recreateMachine(machine.id).then(({ machine: updated }) => updated),
    );
    if (action === 'destroy') runMachineAction(
      action,
      () => client.destroyMachine(machine.id).then(({ machine: updated }) => updated),
    );
  };

  const actions = member === undefined || member.role === 'viewer'
    ? []
    : machineActionsFor(machine);
  const refused = actions.filter((action) => needsAdmin(action, machine) && !admin);

  return (
    <ModalOverlay onDismiss={onClose}>
      <section
        className="workspace-details-dialog my-machine-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`My machine in ${workspace.title}`}
      >
        <header className="workspace-details-header">
          <h1>My machine <em>“{workspace.title}”</em></h1>
          <button ref={closeButton} type="button" aria-label="Close my machine" onClick={onClose}>×</button>
        </header>
        <div className="workspace-details-body">
          {error !== null && <p className="workspace-details-error" role="alert">{error}</p>}
          {member === undefined ? (
            <p className="workspace-members-empty">You are not a member of this workspace.</p>
          ) : member.role === 'viewer' ? (
            <p className="workspace-members-empty">
              A viewer holds no machine. Viewers watch the workspace; they do not
              run it. {askLine(workspace.members)} to change your role.
            </p>
          ) : (
            <section className="my-machine-panel">
              <div className="cfg-section">
                <div className="cfg-section-head">
                  <h2 className="cfg-title">Machine</h2>
                </div>
                <dl className="cfg-meta">
                  <div>
                    <dt>Status</dt>
                    {/* `MachineState` is a wire term shown to a person. */}
                    <dd className="cfg-meta-term">
                      {pendingAction === null
                        ? machine === null ? 'No machine' : machine.state
                        : machinePendingLabel(pendingAction)}
                    </dd>
                  </div>
                  <Detail
                    label="Machine type"
                    value={type?.name ?? machine?.machineTypeId ?? workspace.defaultMachineTypeId}
                  />
                  {type !== undefined && <>
                    <Detail label="CPU" value={`${String(type.cpuCores)} vCPU`} />
                    <Detail label="Memory" value={`${String(type.memGb)} GB`} />
                    <Detail label="Disk" value={`${String(type.diskGb)} GB`} />
                    <Detail label="Price" value={price ?? 'Unavailable'} />
                  </>}
                  <div>
                    <dt>Persistent volume</dt>
                    <dd>
                      <VolumeMeter
                        volumeId={machine?.volumeId ?? null}
                        usedPercent={machine?.volumeUsedPercent ?? null}
                      />
                    </dd>
                  </div>
                  <Detail label="Created" value={machine === null ? 'Unavailable' : dateLabel(machine.createdAt)} />
                </dl>
                {type === undefined && machine !== null && (
                  <p className="cfg-help">{catalogGap(catalog, machine.machineTypeId)}</p>
                )}
                {machine?.error != null && (
                  <p className="workspace-details-error" role="alert">{machine.error}</p>
                )}
              </div>

              <div className="cfg-section">
                <div className="cfg-section-head">
                  <h2 className="cfg-title">Machine type</h2>
                </div>
                {admin && machine !== null ? (
                  <MachineTypeSelect
                    machines={machines}
                    value={machine.machineTypeId}
                    defaultMachineTypeId={workspace.defaultMachineTypeId}
                    volumeLocation={volumeLocationOf(machine, machines)}
                    ariaLabel="Change my machine type"
                    disabled={pendingAction !== null}
                    onChange={(machineTypeId) => {
                      if (machineTypeId !== machine.machineTypeId) setPendingTypeId(machineTypeId);
                    }}
                  />
                ) : (
                  <p className="cfg-help">
                    {machine === null
                      ? 'There is no machine to re-type yet.'
                      : `Changing a machine's type is workspace-admin work. ${askLine(workspace.members)}`}
                  </p>
                )}
              </div>

              <div className="cfg-section">
                <div className="cfg-section-head">
                  <h2 className="cfg-title">Lifecycle</h2>
                </div>
                {actions.length === 0 && (
                  <p className="cfg-help">
                    {machine === null
                      ? 'You have no machine yet.'
                      : `A machine that is ${machine.state} accepts nothing until it arrives.`}
                  </p>
                )}
                <div className="cfg-actions">
                  {actions.map((action) => {
                    const blocked = needsAdmin(action, machine) && !admin;
                    return (
                      <button
                        className={action === 'destroy'
                          ? 'cfg-danger-action'
                          : 'webapp-action'}
                        type="button"
                        key={action}
                        disabled={blocked || pendingAction !== null}
                        title={blocked ? askLine(workspace.members) : undefined}
                        onClick={() => act(action)}
                      >
                        {ACTION_LABELS[action]}
                      </button>
                    );
                  })}
                </div>
                {refused.length > 0 && (
                  <p className="cfg-help">{askLine(workspace.members)}</p>
                )}
              </div>
            </section>
          )}
        </div>
      </section>
      {pendingTypeId !== null && machine !== null && (
        <ConfirmationDialog
          title="Change machine type?"
          description={`This replaces your VM with a ${pendingTypeId} one. It keeps the disk — the volume and everything on it survives — but running sessions restart.`}
          confirmLabel="Yes, change the type"
          onCancel={() => setPendingTypeId(null)}
          onConfirm={() => {
            const machineTypeId = pendingTypeId;
            setPendingTypeId(null);
            runMachineAction(
              'recreate',
              () => client.setMachineType(machine.id, { machineTypeId })
                .then(({ machine: updated }) => updated),
              'Couldn’t change machine type',
            );
          }}
        />
      )}
    </ModalOverlay>
  );
}
