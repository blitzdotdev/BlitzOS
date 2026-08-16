import * as schema from "@blitzos/schema";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as wire from "../core/wire.js";

type SharedShape<Wire, Schema> = Wire & Schema;

const machineType: SharedShape<wire.MachineType, schema.MachineType> = {
  id: "mv-2c2g@lab",
  providerId: "microvm",
  supportsVolumes: false,
  name: "MicroVM 2 vCPU / 2 GB",
  cpuCores: 2,
  memGb: 2,
  diskGb: 8,
  arch: "x86",
  location: "lab",
};

const machineTypeFailure: SharedShape<
  wire.MachineTypeProviderFailure,
  schema.MachineTypeProviderFailure
> = {
  providerId: "microvm",
  error: "capacity unavailable",
};

const volume: SharedShape<wire.Volume, schema.Volume> = {
  id: "volume",
  name: "state",
  sizeGb: 20,
  location: "fsn1",
  status: "attached",
  attachedTo: "workspace",
};

const workspace: SharedShape<wire.WorkspaceView, schema.WorkspaceView> = {
  id: "workspace",
  name: "brave-otter",
  machineTypeId: "mv-2c2g@lab",
  phase: "ready",
  retryAction: null,
  canObserve: true,
  launchable: true,
  revision: 3,
  ssh: {
    host: "203.0.113.10",
    port: 22,
    user: "blitz",
    hostPublicKey: "ssh-ed25519 AAAAhost",
  },
  volumeId: volume.id,
  error: null,
  role: "owner",
  owner: { name: "Owner", avatarUrl: null },
};

const listMachineTypesResponse: SharedShape<
  wire.ListMachineTypesResponse,
  schema.ListMachineTypesResponse
> = {
  machineTypes: [machineType],
  failures: [machineTypeFailure],
};

const createWorkspaceRequest: SharedShape<
  wire.CreateWorkspaceRequest,
  schema.CreateWorkspaceRequest
> = {
  machineTypeId: machineType.id,
  sshPublicKey: "ssh-ed25519 AAAAcaller",
  volumeId: volume.id,
  userData: "#cloud-config\n",
  manifest: {
    integrations: {
      github: { scopes: ["contents:read"] },
    },
  },
};

const createWorkspaceResponse: SharedShape<
  wire.CreateWorkspaceResponse,
  schema.CreateWorkspaceResponse
> = { workspace };

const pollResponse: SharedShape<wire.PollResponse, schema.PollResponse> = {
  workspaces: [workspace],
};

const registerKeysResponse: SharedShape<
  wire.RegisterKeysResponse,
  schema.RegisterKeysResponse
> = {
  memberUnixName: "operator",
  broker: {
    host: "broker.example",
    port: 2222,
    sshHostPublicKey: "ssh-ed25519 AAAAbroker",
  },
};

const apiError: SharedShape<wire.ApiError, schema.ApiError> = {
  error: "workspace is still creating",
  retryAction: "poll",
};

const createVolumeRequest: SharedShape<
  wire.CreateVolumeRequest,
  schema.CreateVolumeRequest
> = {
  name: volume.name,
  sizeGb: volume.sizeGb,
  location: volume.location,
};

const createVolumeResponse: SharedShape<
  wire.CreateVolumeResponse,
  schema.CreateVolumeResponse
> = { volume };

const listVolumesResponse: SharedShape<
  wire.ListVolumesResponse,
  schema.ListVolumesResponse
> = { volumes: [volume] };

const deleteVolumeResponse: SharedShape<
  wire.DeleteVolumeResponse,
  schema.DeleteVolumeResponse
> = { id: volume.id };

const feedKey: SharedShape<wire.FeedKey, schema.FeedKey> = {
  pubkey: "ssh-ed25519 AAAAkey",
  op: "mint",
};

const feedMember: SharedShape<wire.FeedMember, schema.FeedMember> = {
  unixName: "operator",
  harnesses: ["claude", "codex"],
  keys: [feedKey],
};

const feedResponse: SharedShape<wire.FeedResponse, schema.FeedResponse> = {
  version: "version",
  members: [feedMember],
};

const folderGrant: SharedShape<wire.FolderGrantView, schema.FolderGrantView> = {
  id: "grant",
  membershipId: "member",
  role: "editor",
  createdAt: 1,
  member: { name: "Editor", email: "editor@example.com", avatarUrl: null },
};

const folder: SharedShape<wire.FolderView, schema.FolderView> = {
  id: "folder",
  name: "Shared",
  role: "owner",
  owner: { name: "Owner", avatarUrl: null },
  attachedWorkspaceIds: ["workspace"],
  createdAt: 1,
  updatedAt: 2,
  grants: [folderGrant],
};

const folderObject: SharedShape<wire.FolderObjectView, schema.FolderObjectView> = {
  key: "notes/today.txt",
  size: 12,
  mtime: 1,
  editedBy: "Editor",
};

const folderObjects: SharedShape<
  wire.ListFolderObjectsResponse,
  schema.ListFolderObjectsResponse
> = { objects: [folderObject], cursor: null, truncated: false };

const folderAttachment: SharedShape<
  wire.FolderAttachmentView,
  schema.FolderAttachmentView
> = {
  id: "folder",
  name: "Shared",
  guestPath: null,
  role: "editor",
  attachedAt: 3,
};

const folderAttachments: SharedShape<
  wire.ListFolderAttachmentsResponse,
  schema.ListFolderAttachmentsResponse
> = { folders: [folderAttachment] };

const fullFieldValues = [
  machineType,
  machineTypeFailure,
  volume,
  workspace,
  listMachineTypesResponse,
  createWorkspaceRequest,
  createWorkspaceResponse,
  pollResponse,
  registerKeysResponse,
  apiError,
  createVolumeRequest,
  createVolumeResponse,
  listVolumesResponse,
  deleteVolumeResponse,
  feedKey,
  feedMember,
  feedResponse,
  folderGrant,
  folder,
  folderObject,
  folderObjects,
  folderAttachment,
  folderAttachments,
];

describe("local wire copies", () => {
  it("keeps every duplicated type exactly equal to @blitzos/schema", () => {
    expectTypeOf<wire.Phase>().toEqualTypeOf<schema.Phase>();
    expectTypeOf<wire.RetryAction>().toEqualTypeOf<schema.RetryAction>();
    expectTypeOf<wire.WorkspaceRole>().toEqualTypeOf<schema.WorkspaceRole>();
    expectTypeOf<wire.MachineType>().toEqualTypeOf<schema.MachineType>();
    expectTypeOf<wire.MachineTypeProviderFailure>().toEqualTypeOf<schema.MachineTypeProviderFailure>();
    expectTypeOf<wire.Volume>().toEqualTypeOf<schema.Volume>();
    expectTypeOf<wire.WorkspaceView>().toEqualTypeOf<schema.WorkspaceView>();
    expectTypeOf<wire.ListMachineTypesResponse>().toEqualTypeOf<schema.ListMachineTypesResponse>();
    expectTypeOf<wire.CreateWorkspaceRequest>().toEqualTypeOf<schema.CreateWorkspaceRequest>();
    expectTypeOf<wire.CreateWorkspaceResponse>().toEqualTypeOf<schema.CreateWorkspaceResponse>();
    expectTypeOf<wire.PollResponse>().toEqualTypeOf<schema.PollResponse>();
    expectTypeOf<wire.RegisterKeysResponse>().toEqualTypeOf<schema.RegisterKeysResponse>();
    expectTypeOf<wire.ApiError>().toEqualTypeOf<schema.ApiError>();
    expectTypeOf<wire.CreateVolumeRequest>().toEqualTypeOf<schema.CreateVolumeRequest>();
    expectTypeOf<wire.CreateVolumeResponse>().toEqualTypeOf<schema.CreateVolumeResponse>();
    expectTypeOf<wire.ListVolumesResponse>().toEqualTypeOf<schema.ListVolumesResponse>();
    expectTypeOf<wire.DeleteVolumeResponse>().toEqualTypeOf<schema.DeleteVolumeResponse>();
    expectTypeOf<wire.FeedResponse>().toEqualTypeOf<schema.FeedResponse>();
    expectTypeOf<wire.FeedMember>().toEqualTypeOf<schema.FeedMember>();
    expectTypeOf<wire.FeedKey>().toEqualTypeOf<schema.FeedKey>();
    expectTypeOf<wire.FolderRole>().toEqualTypeOf<schema.FolderRole>();
    expectTypeOf<wire.FolderGrantView>().toEqualTypeOf<schema.FolderGrantView>();
    expectTypeOf<wire.FolderView>().toEqualTypeOf<schema.FolderView>();
    expectTypeOf<wire.FolderObjectView>().toEqualTypeOf<schema.FolderObjectView>();
    expectTypeOf<wire.ListFolderObjectsResponse>().toEqualTypeOf<schema.ListFolderObjectsResponse>();
    expectTypeOf<wire.FolderAttachmentView>().toEqualTypeOf<schema.FolderAttachmentView>();
    expectTypeOf<wire.ListFolderAttachmentsResponse>().toEqualTypeOf<schema.ListFolderAttachmentsResponse>();
  });

  it("keeps every duplicated constant and every field-bearing JSON shape covered", () => {
    expect(wire.FEED_MAX_BYTES).toBe(schema.FEED_MAX_BYTES);
    expect(wire.HARNESSES).toEqual(schema.HARNESSES);
    expect(wire.PHASES).toEqual(schema.PHASES);
    expect(wire.RETRY_ACTIONS).toEqual(schema.RETRY_ACTIONS);
    expect(wire.PHASE_TRANSITIONS).toEqual(schema.PHASE_TRANSITIONS);
    expect(wire.INVITE_TTL_DAYS).toBe(schema.INVITE_TTL_DAYS);
    expect(wire.FILES_MULTIPART_CHUNK_BYTES).toBe(schema.FILES_MULTIPART_CHUNK_BYTES);
    for (const value of fullFieldValues) {
      expect(JSON.parse(JSON.stringify(value))).toEqual(value);
    }
  });
});
