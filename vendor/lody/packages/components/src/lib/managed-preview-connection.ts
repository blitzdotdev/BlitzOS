import { getServerNow, isAllowedPreviewPublicUrl, type PreviewConnection } from '@lody/shared';
import { previewPublicBaseDomain } from './preview-public-config';

const isLeaseExpired = (connection: PreviewConnection | null | undefined, now: number): boolean =>
  connection?.status === 'active' &&
  typeof connection.leaseExpiresAt === 'number' &&
  connection.leaseExpiresAt <= now;

export const hasUsableManagedPreviewUrl = (
  connection: PreviewConnection | null | undefined,
  now: number = getServerNow()
): connection is PreviewConnection & { status: 'active'; publicUrl: string } =>
  connection?.status === 'active' &&
  !isLeaseExpired(connection, now) &&
  isAllowedPreviewPublicUrl(connection.publicUrl, previewPublicBaseDomain);
