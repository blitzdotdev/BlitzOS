import type { ControlPlaneClient } from '../api';
import type { TenantMe } from '../api-adapter';
import { FilesDrive } from '../files/FilesDrive';

export function FilesPanel({
  client,
  viewer,
}: {
  client: ControlPlaneClient;
  viewer: TenantMe;
}) {
  return <FilesDrive client={client} viewer={viewer} />;
}
