import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ListMachineTypesResponse, MachineType, Volume } from '@blitzos/schema';
import type { ControlPlaneClient, WorkspaceGrantView } from './api';
import { DriveAvatar } from './files/DriveAvatar';
import { ModalOverlay } from './ModalOverlay';
import type { CloudWorkspaceModel } from './workspace-store';

function providerLabel(providerId: string): string {
  if (providerId === 'microvm') return 'Local lab';
  if (providerId === 'hetzner') return 'Hetzner';
  if (providerId === 'aws') return 'AWS';
  return providerId;
}

function dateLabel(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'Unavailable';
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp));
}

function yesNo(value: boolean): string {
  return value ? 'Yes' : 'No';
}

function DetailList({ children }: { children: ReactNode }) {
  return <dl className="workspace-details-list">{children}</dl>;
}

function Detail({ label, value }: { label: string; value: ReactNode }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function ComputeDetails({ machine, fallback }: { machine: MachineType | null; fallback: string | null }) {
  return (
    <DetailList>
      <Detail label="Machine" value={machine?.name ?? fallback ?? 'Unavailable'} />
      <Detail label="Provider" value={machine ? providerLabel(machine.providerId) : 'Unavailable'} />
      <Detail label="Location" value={machine?.location || 'Unavailable'} />
      <Detail label="CPU" value={machine ? `${machine.cpuCores} vCPU` : 'Unavailable'} />
      <Detail label="Memory" value={machine ? `${machine.memGb} GB` : 'Unavailable'} />
      <Detail label="Disk" value={machine ? `${machine.diskGb} GB` : 'Unavailable'} />
    </DetailList>
  );
}

function StorageDetails({ attached, volume }: { attached: boolean; volume: Volume | null }) {
  return (
    <DetailList>
      <Detail label="Persistent volume" value={attached ? 'Attached' : 'Not attached'} />
      {attached && <Detail label="Volume" value={volume?.name ?? 'Attached volume'} />}
      {attached && <Detail label="Size" value={volume ? `${volume.sizeGb} GB` : 'Unavailable'} />}
      {attached && <Detail label="Location" value={volume?.location || 'Unavailable'} />}
    </DetailList>
  );
}

export function WorkspaceDetailsDialog({
  client,
  workspace,
  orgName,
  listMachineTypes,
  listVolumes,
  onClose,
  onDelete,
}: {
  client: ControlPlaneClient;
  workspace: CloudWorkspaceModel;
  orgName: string;
  listMachineTypes: () => Promise<ListMachineTypesResponse>;
  listVolumes: () => Promise<Volume[]>;
  onClose: () => void;
  onDelete: (() => void) | null;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const [machines, setMachines] = useState<MachineType[]>([]);
  const [volumes, setVolumes] = useState<Volume[]>([]);
  const [grants, setGrants] = useState<WorkspaceGrantView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { closeButton.current?.focus(); }, []);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.all([
      listMachineTypes(),
      listVolumes(),
      client.listWorkspaceGrants(workspace.id),
    ]).then(([machineResponse, volumeResponse, grantResponse]) => {
      if (cancelled) return;
      setMachines(machineResponse.machineTypes);
      setVolumes(volumeResponse);
      setGrants(grantResponse.grants);
      setError(null);
    }).catch((caught: Error) => {
      if (!cancelled) setError(caught.message || 'Could not load workspace details.');
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [client, listMachineTypes, listVolumes, workspace.id]);

  const machine = machines.find(({ id }) => id === workspace.machineType) ?? null;
  const volume = volumes.find(({ id }) => id === workspace.volumeId) ?? null;
  const ownerName = workspace.owner?.name ?? 'Workspace owner';

  return (
    <ModalOverlay onDismiss={onClose}>
      <section
        className="workspace-details-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Workspace details for ${workspace.title}`}
      >
        <header className="workspace-details-header">
          <div><span>Workspace details</span><h1>{workspace.title}</h1></div>
          <button ref={closeButton} type="button" aria-label="Close workspace details" onClick={onClose}>×</button>
        </header>
        <div className="workspace-details-body">
          {loading && <p className="workspace-details-status" role="status">Loading workspace details…</p>}
          {error && <p className="workspace-details-error" role="alert">{error}</p>}
          <div className="workspace-details-grid">
            <section><h2>Compute</h2><ComputeDetails machine={machine} fallback={workspace.machineType} /></section>
            <section><h2>Storage</h2><StorageDetails attached={workspace.volumeId !== null} volume={volume} /></section>
            <section>
              <h2>Workspace</h2>
              <DetailList>
                <Detail label="Status" value={workspace.lifecycleStatus} />
                <Detail label="Owner" value={ownerName} />
                <Detail label="Your access" value={workspace.accessRole ?? 'None'} />
                <Detail label="Created" value={dateLabel(workspace.createdAt)} />
                <Detail label="Updated" value={dateLabel(workspace.updatedAt)} />
              </DetailList>
            </section>
            <section>
              <h2>Configuration</h2>
              <DetailList>
                <Detail label="Environment variables" value={yesNo(workspace.environmentConfigured)} />
                <Detail label="Startup script" value={yesNo(workspace.startupConfigured)} />
                <Detail label="Connections" value={workspace.connections.length} />
              </DetailList>
            </section>
          </div>
          <section className="workspace-details-access">
            <h2>Who has access</h2>
            <div className="workspace-details-people">
              <div className="workspace-details-person">
                <DriveAvatar name={ownerName} avatarUrl={workspace.owner?.avatarUrl ?? null} size="md" />
                <span><strong>{ownerName}</strong><small>Workspace owner</small></span>
                <b>Owner</b>
              </div>
              <div className="workspace-details-person">
                <span className="workspace-details-org" aria-hidden="true">{orgName.charAt(0).toUpperCase()}</span>
                <span><strong>Everyone at {orgName}</strong><small>General workspace access</small></span>
                <b>{workspace.orgShareRole ?? 'Restricted'}</b>
              </div>
              {grants.map((grant) => (
                <div className="workspace-details-person" key={grant.id}>
                  <DriveAvatar name={grant.member.name || grant.member.email} avatarUrl={grant.member.avatarUrl} size="md" />
                  <span><strong>{grant.member.name || grant.member.email}</strong><small>{grant.member.email}</small></span>
                  <b>{grant.role}</b>
                </div>
              ))}
            </div>
          </section>
        </div>
        {onDelete && (
          <footer className="workspace-details-footer">
            <button className="workspace-details-delete" type="button" onClick={onDelete}>Delete workspace</button>
          </footer>
        )}
      </section>
    </ModalOverlay>
  );
}
