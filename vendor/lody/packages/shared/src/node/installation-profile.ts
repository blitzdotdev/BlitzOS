import os from 'node:os';
import path from 'node:path';
import { resolvePlatformKind, type PlatformKind } from '../platform-kind';

export type InstallationProfile = {
  platform: PlatformKind;
  namespace: 'lody' | 'lody-oss';
  dataDirectoryName: '.lody' | '.lody-oss';
  desktopProtocol: 'lody' | 'lody-oss';
  desktopProductName: 'Lody' | 'Lody OSS';
  desktopAppId: 'ai.lody.desktop' | 'dev.loro.lody.oss';
  localCliHostPort: 17_788 | 17_789;
};

const CLOUD_PROFILE: InstallationProfile = {
  platform: 'cloud',
  namespace: 'lody',
  dataDirectoryName: '.lody',
  desktopProtocol: 'lody',
  desktopProductName: 'Lody',
  desktopAppId: 'ai.lody.desktop',
  localCliHostPort: 17_788,
};

const LOCAL_PROFILE: InstallationProfile = {
  platform: 'local',
  namespace: 'lody-oss',
  dataDirectoryName: '.lody-oss',
  desktopProtocol: 'lody-oss',
  desktopProductName: 'Lody OSS',
  desktopAppId: 'dev.loro.lody.oss',
  localCliHostPort: 17_789,
};

/**
 * Returns the immutable installation profile selected at process assembly.
 * Invalid values fail before any state path or IPC endpoint is used.
 */
export function getInstallationProfile(
  platform: PlatformKind = resolvePlatformKind(process.env.LODY_PLATFORM),
): InstallationProfile {
  return platform === 'local' ? LOCAL_PROFILE : CLOUD_PROFILE;
}

/** Root for process-owned durable state. Callers may inject a home in tests. */
export function getLodyDataDir(
  platform?: PlatformKind,
  homeDir: string = os.homedir(),
): string {
  const override = process.env.LODY_DATA_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(homeDir, getInstallationProfile(platform).dataDirectoryName);
}
