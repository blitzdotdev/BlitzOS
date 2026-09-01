import os from 'os';
import * as fs from 'fs/promises';

import type { Logger } from './logger';
import { formatErrorMessage } from './format-error';

export interface ProcessResourceProfile {
  nice?: number;
  oomScoreAdj?: number;
}

interface ProcessResourceProfileDeps {
  platform: NodeJS.Platform;
  setPriority: typeof os.setPriority;
  writeFile: typeof fs.writeFile;
}

interface ApplyProcessResourceProfileOptions {
  logger?: Logger;
  label: string;
  deps?: Partial<ProcessResourceProfileDeps>;
}

const OOM_SCORE_ADJ_MIN = -1000;
const OOM_SCORE_ADJ_MAX = 1000;

// Avoid inheriting aggressive sshd protection into the long-lived CLI control plane.
export const CONTROL_PLANE_RESOURCE_PROFILE: ProcessResourceProfile = {
  nice: 0,
  oomScoreAdj: 0,
};

// Session work should be killable before system services or the CLI control plane.
export const EXECUTION_PLANE_RESOURCE_PROFILE: ProcessResourceProfile = {
  nice: 0,
  oomScoreAdj: 200,
};

export async function normalizeCurrentProcessResourceProfile(logger?: Logger): Promise<void> {
  await applyProcessResourceProfile(process.pid, CONTROL_PLANE_RESOURCE_PROFILE, {
    label: 'control-plane process',
    logger,
  });
}

export async function applyExecutionProcessResourceProfile(
  pid: number,
  logger?: Logger
): Promise<void> {
  await applyProcessResourceProfile(pid, EXECUTION_PLANE_RESOURCE_PROFILE, {
    label: 'execution-plane process',
    logger,
  });
}

export async function applyProcessResourceProfile(
  pid: number,
  profile: ProcessResourceProfile,
  options: ApplyProcessResourceProfileOptions
): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }

  const deps: ProcessResourceProfileDeps = {
    platform: process.platform,
    setPriority: os.setPriority,
    writeFile: fs.writeFile,
    ...(options.deps ?? {}),
  };

  if (deps.platform !== 'linux') {
    return;
  }

  if (profile.nice !== undefined) {
    try {
      deps.setPriority(pid, profile.nice);
    } catch (error) {
      options.logger?.debug(
        `[ProcessResourceProfile] Failed to set ${options.label} ${pid} nice=${profile.nice}: ${formatErrorMessage(
          error
        )}`
      );
    }
  }

  const oomScoreAdj = normalizeOomScoreAdj(profile.oomScoreAdj);
  if (oomScoreAdj === undefined) {
    return;
  }

  try {
    await deps.writeFile(`/proc/${pid}/oom_score_adj`, `${oomScoreAdj}\n`);
  } catch (error) {
    options.logger?.debug(
      `[ProcessResourceProfile] Failed to set ${options.label} ${pid} oom_score_adj=${oomScoreAdj}: ${formatErrorMessage(
        error
      )}`
    );
  }
}

function normalizeOomScoreAdj(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(OOM_SCORE_ADJ_MIN, Math.min(OOM_SCORE_ADJ_MAX, Math.trunc(value)));
}
