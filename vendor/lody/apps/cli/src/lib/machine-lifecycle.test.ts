import { describe, expect, it } from 'vitest';
import {
  buildLodyUpgradeInstallArgs,
  normalizeMachineUpgradeTargetVersion,
  resolveMachineLifecycleCapability,
  resolveNpmExecutable,
} from './machine-lifecycle';

describe('machine lifecycle helpers', () => {
  it('defaults upgrade target to latest', () => {
    expect(normalizeMachineUpgradeTargetVersion()).toBe('latest');
    expect(normalizeMachineUpgradeTargetVersion('  latest  ')).toBe('latest');
  });

  it('accepts exact semver-like upgrade targets', () => {
    expect(normalizeMachineUpgradeTargetVersion('1.2.3')).toBe('1.2.3');
    expect(normalizeMachineUpgradeTargetVersion('1.2.3-beta.1')).toBe('1.2.3-beta.1');
  });

  it('rejects arbitrary npm package specs', () => {
    expect(() => normalizeMachineUpgradeTargetVersion('git+https://example.com/repo.git')).toThrow(
      /exact semver/
    );
    expect(() => normalizeMachineUpgradeTargetVersion('file:/tmp/lody.tgz')).toThrow(
      /exact semver/
    );
    expect(() => normalizeMachineUpgradeTargetVersion('next')).toThrow(/exact semver/);
  });

  it('builds a fixed npm global install command for lody only', () => {
    expect(buildLodyUpgradeInstallArgs('1.2.3')).toEqual([
      'install',
      '-g',
      'lody@1.2.3',
      '--registry=https://registry.npmjs.org',
    ]);
  });

  it('uses npm.cmd on Windows', () => {
    expect(resolveNpmExecutable('win32')).toBe('npm.cmd');
    expect(resolveNpmExecutable('linux')).toBe('npm');
  });

  it('enables remote lifecycle only for supervised daemon workers', () => {
    expect(resolveMachineLifecycleCapability('daemon')).toEqual({
      launchMode: 'daemon',
      canRemoteRestart: true,
      canRemoteUpgrade: true,
    });
  });

  it('disables remote lifecycle for Electron managed CLI', () => {
    expect(resolveMachineLifecycleCapability('electron')).toEqual({
      launchMode: 'electron',
      canRemoteRestart: false,
      canRemoteUpgrade: false,
      reason: 'electron',
    });
  });

  it('disables remote lifecycle for foreground lody start', () => {
    expect(resolveMachineLifecycleCapability(undefined)).toEqual({
      launchMode: 'foreground',
      canRemoteRestart: false,
      canRemoteUpgrade: false,
      reason: 'not_daemon',
    });
  });
});
