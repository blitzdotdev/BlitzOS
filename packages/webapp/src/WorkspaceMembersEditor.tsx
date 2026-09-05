import type {
  MachineType,
  MachineView,
  WorkspaceMemberRole,
  WorkspaceMemberView,
} from '@blitzos/schema';
import { useEffect, useRef, useState } from 'react';
import type { MemberView } from './api';
import { MemberAvatar } from './MemberAvatar';
import { VolumeMeter } from './VolumeMeter';
import { MachineTypeSelect, WORKSPACE_DEFAULT_MACHINE_TYPE } from './MachineTypeSelect';
import { WebAppSelectMenu } from './WebAppSelectMenu';

/** A member a create request has not sent yet. `machineTypeId` empty means
 * "take the workspace default" and travels as an absent field. */
export type DraftWorkspaceMember = {
  membershipId: string;
  role: WorkspaceMemberRole;
  machineTypeId: string;
  /** Default true. False provisions this member's machine with no volume of
   * its own, so nothing on it outlives the VM. */
  persistentVolume: boolean;
};

/** The lifecycle verbs of plan §6, in the order the menu lists them. */
export type MachineAction = 'provision' | 'stop' | 'start' | 'recreate' | 'destroy';

const ROLE_LABELS = {
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
} satisfies Record<WorkspaceMemberRole, string>;

const ROLE_OPTIONS = (['admin', 'member', 'viewer'] as const).map((role) => ({
  value: role,
  label: ROLE_LABELS[role],
}));

const MACHINE_ACTION_LABELS = {
  provision: 'Provision',
  stop: 'Stop',
  start: 'Start',
  recreate: 'Recreate',
  destroy: 'Destroy',
} satisfies Record<MachineAction, string>;

/**
 * Which verbs this machine's state can accept.
 *
 * A member with no machine gets exactly one: `provision`. The wire sends
 * `machine: null` where the workspace does not auto-provision, or where theirs
 * was destroyed, and that row is keyed by the membership rather than by a
 * machine id — which is why it took its own route.
 *
 * `provision` appears again on an error row, the one reachable state whose VM
 * may be missing. A machine that is going somewhere accepts nothing until it
 * arrives.
 */
export function machineActionsFor(machine: MachineView | null): MachineAction[] {
  if (machine === null) return ['provision'];
  if (machine.state === 'provisioning' || machine.state === 'destroying') return [];
  if (machine.state === 'stopped') return ['start', 'destroy'];
  if (machine.state === 'error') return ['provision', 'recreate', 'destroy'];
  return ['stop', 'recreate', 'destroy'];
}

function MachineStateChip({ machine }: { machine: MachineView | null }) {
  const state = machine?.state ?? 'none';
  return (
    <span className={`machine-chip machine-chip--${state}`}>
      {machine === null ? 'No machine' : machine.state}
    </span>
  );
}

/** The people search lifted from `ShareWorkspaceDialog`: active org members
 * who are not on the list yet, filtered by name or email. */
function AddMemberSearch({
  candidates,
  autoFocus,
  onAdd,
}: {
  candidates: MemberView[];
  /** The tile menu's Invite opens the dialog to do exactly this. */
  autoFocus: boolean;
  onAdd: (member: MemberView) => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { if (autoFocus) field.current?.focus(); }, [autoFocus]);
  const trimmed = query.trim().toLowerCase();
  const matches = candidates
    .filter((member) => trimmed === ''
      || member.name.toLowerCase().includes(trimmed)
      || member.email.toLowerCase().includes(trimmed))
    .slice(0, 5);
  return (
    <div className="workspace-members-search">
      <input
        ref={field}
        className="member-search-field"
        type="text"
        autoComplete="off"
        placeholder="Add people"
        aria-label="Add people"
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(event) => { setQuery(event.currentTarget.value); setOpen(true); }}
      />
      {open && (
        <div className="member-suggestions">
          {matches.length === 0
            ? <div className="member-suggestion-empty">No one else to add</div>
            : matches.map((member) => (
              <button
                className="member-suggestion"
                type="button"
                key={member.id}
                onClick={() => {
                  setQuery('');
                  setOpen(false);
                  onAdd(member);
                }}
              >
                <MemberAvatar name={member.name || member.email} avatarUrl={member.avatarUrl} size="md" />
                <span className="member-person-copy">
                  <strong>{member.name || member.email}</strong>
                  <span>{member.email}</span>
                </span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

/** The volume's location, so `SetMachineType` can refuse the types that
 * cannot reach it. Derived from the machine's current type, because the
 * volume is created in that type's location. */
function machineLocation(
  machine: MachineView | null,
  machines: readonly MachineType[],
): string | null {
  if (machine === null || machine.volumeId === null) return null;
  const current = machines.find(({ id }) => id === machine.machineTypeId);
  if (current === undefined) return null;
  return current.location || current.id.split('@').at(-1) || null;
}

/** One row, whichever mode drew it. */
function MemberRow({
  name,
  avatarUrl,
  role,
  machineTypeId,
  persistentVolume,
  machine,
  machines,
  defaultMachineTypeId,
  pinned,
  readOnly,
  onRoleChange,
  onMachineTypeChange,
  onPersistentVolumeChange,
  onMachineAction,
  onRemove,
}: {
  name: string;
  avatarUrl: string | null;
  role: WorkspaceMemberRole;
  machineTypeId: string;
  persistentVolume: boolean;
  /** Live mode only; null in draft mode, where no machine exists yet. */
  machine: MachineView | null;
  machines: readonly MachineType[];
  defaultMachineTypeId: string;
  /** The creator, who is the first workspace admin and cannot be removed. */
  pinned: boolean;
  readOnly: boolean;
  onRoleChange: (role: WorkspaceMemberRole) => void;
  onMachineTypeChange: (machineTypeId: string) => void;
  onPersistentVolumeChange: (persistentVolume: boolean) => void;
  onMachineAction: ((action: MachineAction) => void) | null;
  onRemove: () => void;
}) {
  // A viewer never holds a machine (§2.2), so the type select would be a
  // control over something that does not exist.
  const showMachine = role !== 'viewer';
  // The volume is created with the machine, so the toggle is a choice only
  // while there is no machine. On a row that has one the meter reports the disk
  // that exists — how full it is — rather than offering to change it, which
  // this route cannot do.
  const volumeDecided = machine !== null;
  // The pinned creator row of a draft has no choice to make: the workspace
  // creator's own machine is provisioned before any member row is read.
  const showVolume = showMachine && (volumeDecided || !pinned);
  const actions = onMachineAction === null ? [] : machineActionsFor(machine);
  return (
    <div className="workspace-member-row">
      <MemberAvatar name={name} avatarUrl={avatarUrl} size="md" />
      <span className="workspace-member-name">
        <strong>{name}</strong>
        {pinned && <small>Workspace owner</small>}
      </span>
      {readOnly || pinned ? (
        <span className="workspace-member-role-static">{ROLE_LABELS[role]}</span>
      ) : (
        <WebAppSelectMenu
          ariaLabel={`Role for ${name}`}
          className="workspace-member-role"
          value={role}
          options={ROLE_OPTIONS}
          onChange={(next) => {
            // SAFETY: the options are exactly WORKSPACE_MEMBER_ROLES.
            onRoleChange(next as WorkspaceMemberRole);
          }}
        />
      )}
      {showMachine && <MachineStateChip machine={machine} />}
      {showMachine && (
        <MachineTypeSelect
          machines={machines}
          value={machineTypeId}
          defaultMachineTypeId={defaultMachineTypeId}
          volumeLocation={machineLocation(machine, machines)}
          ariaLabel={`Machine type for ${name}`}
          disabled={readOnly}
          onChange={onMachineTypeChange}
        />
      )}
      {showVolume && (machine === null ? (
        <label className="workspace-member-volume">
          <input
            type="checkbox"
            aria-label={`Persistent volume for ${name}`}
            checked={persistentVolume}
            disabled={readOnly}
            onChange={(event) => onPersistentVolumeChange(event.currentTarget.checked)}
          />
          <span>Persistent volume</span>
        </label>
      ) : (
        // The disk exists, so the row reports it instead of offering a choice
        // this route cannot make: how full it is, or that there is none.
        <VolumeMeter volumeId={machine.volumeId} usedPercent={machine.volumeUsedPercent} />
      ))}
      {showMachine && actions.length > 0 && (
        <WebAppSelectMenu
          ariaLabel={`Machine actions for ${name}`}
          className="workspace-member-actions"
          value=""
          prefix="⋯"
          options={actions.map((action) => ({ value: action, label: MACHINE_ACTION_LABELS[action] }))}
          onChange={(next) => {
            // SAFETY: the options are exactly the MachineAction values above.
            onMachineAction?.(next as MachineAction);
          }}
        />
      )}
      {!readOnly && !pinned && (
        <button
          className="workspace-member-remove"
          type="button"
          aria-label={`Remove ${name}`}
          onClick={onRemove}
        >
          ×
        </button>
      )}
    </div>
  );
}

export type WorkspaceMembersEditorMode =
  | {
    kind: 'draft';
    members: DraftWorkspaceMember[];
    onChange: (members: DraftWorkspaceMember[]) => void;
  }
  | {
    kind: 'live';
    members: WorkspaceMemberView[];
    readOnly: boolean;
    ownerMembershipId: string | null;
    onAdd: (input: {
      membershipId: string;
      role: WorkspaceMemberRole;
      machineTypeId: string;
      persistentVolume: boolean;
    }) => void;
    onRoleChange: (membershipId: string, role: WorkspaceMemberRole) => void;
    onMachineTypeChange: (member: WorkspaceMemberView, machineTypeId: string) => void;
    onMachineAction: (
      member: WorkspaceMemberView,
      action: MachineAction,
      options: { persistentVolume: boolean },
    ) => void;
    onRemove: (member: WorkspaceMemberView) => void;
  };

/**
 * The member list of plan §6b, in both its modes.
 *
 * *Draft* edits local state and feeds `CreateWorkspaceRequest.members[]`.
 * *Live* calls the API on every edit, and its rows carry the machine state
 * chip and the lifecycle menu of §6.
 *
 * The row is the same either way, so the two modes cannot drift into showing
 * different things about the same member.
 */
export function WorkspaceMembersEditor({
  mode,
  orgMembers,
  machines,
  defaultMachineTypeId,
  autoFocusAdd = false,
  viewerName = 'You',
  viewerAvatarUrl = null,
}: {
  mode: WorkspaceMembersEditorMode;
  orgMembers: MemberView[];
  machines: readonly MachineType[];
  defaultMachineTypeId: string;
  /** Opens with the add-member field focused. */
  autoFocusAdd?: boolean;
  /** Draft mode pins the creator as the first workspace admin. Live mode
   * reads the owner off the member rows, so it never needs this. */
  viewerName?: string;
  viewerAvatarUrl?: string | null;
}) {
  // What a live row asks the NEXT provision for. A draft row carries its own
  // answer in the create request; a live row has nowhere to keep one until
  // there is a machine, so the editor holds it until provision reads it.
  const [volumeIntent, setVolumeIntent] = useState<Record<string, boolean>>({});
  const listed = new Set(mode.members.map(({ membershipId }) => membershipId));
  const readOnly = mode.kind === 'live' && mode.readOnly;
  const candidates = orgMembers.filter((member) =>
    member.status === 'active' && !listed.has(member.id));
  const nameFor = (membershipId: string, fallback: string) => {
    const member = orgMembers.find(({ id }) => id === membershipId);
    return member === undefined ? fallback : member.name || member.email;
  };

  return (
    <div className="workspace-members-editor">
      {!readOnly && (
        <AddMemberSearch
          candidates={candidates}
          autoFocus={autoFocusAdd}
          onAdd={(member) => {
            if (mode.kind === 'draft') {
              mode.onChange([...mode.members, {
                membershipId: member.id,
                role: 'member',
                machineTypeId: WORKSPACE_DEFAULT_MACHINE_TYPE,
                persistentVolume: true,
              }]);
              return;
            }
            mode.onAdd({
              membershipId: member.id,
              role: 'member',
              machineTypeId: WORKSPACE_DEFAULT_MACHINE_TYPE,
              persistentVolume: true,
            });
          }}
        />
      )}
      <div className="workspace-members-rows">
        {mode.kind === 'draft' && (
          <MemberRow
            name={`${viewerName} (you)`}
            avatarUrl={viewerAvatarUrl}
            role="admin"
            machineTypeId={WORKSPACE_DEFAULT_MACHINE_TYPE}
            persistentVolume
            machine={null}
            machines={machines}
            defaultMachineTypeId={defaultMachineTypeId}
            pinned
            readOnly
            onRoleChange={() => undefined}
            onMachineTypeChange={() => undefined}
            onPersistentVolumeChange={() => undefined}
            onMachineAction={null}
            onRemove={() => undefined}
          />
        )}
        {mode.kind === 'draft'
          ? mode.members.map((draft, index) => (
            <MemberRow
              key={draft.membershipId}
              name={nameFor(draft.membershipId, draft.membershipId)}
              avatarUrl={orgMembers.find(({ id }) => id === draft.membershipId)?.avatarUrl ?? null}
              role={draft.role}
              machineTypeId={draft.machineTypeId}
              persistentVolume={draft.persistentVolume}
              machine={null}
              machines={machines}
              defaultMachineTypeId={defaultMachineTypeId}
              pinned={false}
              readOnly={false}
              onRoleChange={(role) => mode.onChange(mode.members.map((current, at) =>
                at === index ? { ...current, role } : current))}
              onMachineTypeChange={(machineTypeId) => mode.onChange(mode.members.map((current, at) =>
                at === index ? { ...current, machineTypeId } : current))}
              onPersistentVolumeChange={(persistentVolume) => mode.onChange(
                mode.members.map((current, at) =>
                  at === index ? { ...current, persistentVolume } : current))}
              onMachineAction={null}
              onRemove={() => mode.onChange(mode.members.filter((_current, at) => at !== index))}
            />
          ))
          : mode.members.map((member) => (
            <MemberRow
              key={member.membershipId}
              name={member.name}
              avatarUrl={member.avatarUrl}
              role={member.role}
              machineTypeId={member.machine?.machineTypeId ?? WORKSPACE_DEFAULT_MACHINE_TYPE}
              persistentVolume={volumeIntent[member.membershipId] ?? true}
              machine={member.machine}
              machines={machines}
              defaultMachineTypeId={defaultMachineTypeId}
              pinned={member.membershipId === mode.ownerMembershipId}
              readOnly={readOnly}
              onRoleChange={(role) => mode.onRoleChange(member.membershipId, role)}
              onMachineTypeChange={(machineTypeId) => mode.onMachineTypeChange(member, machineTypeId)}
              onPersistentVolumeChange={(persistentVolume) => setVolumeIntent((current) => ({
                ...current,
                [member.membershipId]: persistentVolume,
              }))}
              onMachineAction={readOnly ? null : (action) => mode.onMachineAction(member, action, {
                persistentVolume: volumeIntent[member.membershipId] ?? true,
              })}
              onRemove={() => mode.onRemove(member)}
            />
          ))}
        {mode.members.length === 0 && mode.kind === 'live' && (
          <p className="workspace-members-empty">No members yet.</p>
        )}
      </div>
    </div>
  );
}
