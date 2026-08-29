const os = require('node:os');
const path = require('node:path');

const CLOUD_PROFILE = Object.freeze({
  platform: 'cloud',
  namespace: 'lody',
  dataDirectoryName: '.lody',
  desktopProtocol: 'lody',
  desktopProductName: 'Lody',
  desktopAppId: 'ai.lody.desktop',
  localCliHostPort: 17788,
});

const LOCAL_PROFILE = Object.freeze({
  platform: 'local',
  namespace: 'lody-oss',
  dataDirectoryName: '.lody-oss',
  desktopProtocol: 'lody-oss',
  desktopProductName: 'Lody OSS',
  desktopAppId: 'dev.loro.lody.oss',
  localCliHostPort: 17789,
});

function resolvePlatformKind(raw) {
  const value = raw?.trim();
  if (!value) return 'local';
  if (value === 'local' || value === 'cloud') return value;
  throw new Error(
    `Unrecognized LODY_PLATFORM value: ${JSON.stringify(raw)} (expected "local" or "cloud")`
  );
}

function getInstallationProfile(platform = resolvePlatformKind(process.env.LODY_PLATFORM)) {
  return platform === 'local' ? LOCAL_PROFILE : CLOUD_PROFILE;
}

function getLodyDataDir(platform, homeDir = os.homedir()) {
  const override = process.env.LODY_DATA_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(homeDir, getInstallationProfile(platform).dataDirectoryName);
}

module.exports = { getInstallationProfile, getLodyDataDir };
