import {
  classifyManagedRuntimeFailureReason,
  formatManagedRuntimeFailureMessage,
  type EnsureManagedRuntimeOptions,
  type ManagedRuntimeDiagnostics,
  type ManagedRuntimeInstallation,
  type ManagedRuntimeName,
} from '@/agent/managed-agent-runtime';
import { captureCli } from '@/lib/analytics/posthog';
import type { Logger } from '@/utils/logger';

function truncateAnalyticsString(value: string, maxLength = 1_000): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

export interface ManagedRuntimeUpdateManager {
  listAvailableUpdates(): Promise<ManagedRuntimeName[]>;
  getTargetVersion(name: ManagedRuntimeName): string;
  ensureCurrentRuntime(
    name: ManagedRuntimeName,
    options?: EnsureManagedRuntimeOptions
  ): Promise<ManagedRuntimeInstallation>;
  pruneSupersededVersions(name: ManagedRuntimeName): Promise<void>;
  getDiagnostics(name: ManagedRuntimeName): ManagedRuntimeDiagnostics;
}

export class ManagedRuntimeUpdateCoordinator {
  private readonly queued = new Set<ManagedRuntimeName>();
  private readonly attempted = new Set<string>();
  private readonly controller = new AbortController();
  private drainPromise: Promise<void> | null = null;
  private started = false;
  private stopped = false;

  constructor(
    private readonly manager: ManagedRuntimeUpdateManager,
    private readonly logger: Pick<Logger, 'debug' | 'error'>
  ) {}

  async start(): Promise<void> {
    if (this.started) {
      throw new Error('Managed runtime update coordinator has already started');
    }
    this.started = true;
    const updates = await this.manager.listAvailableUpdates();
    for (const name of updates) {
      this.enqueue(name);
    }
  }

  enqueue(name: ManagedRuntimeName): void {
    if (!this.started || this.stopped) {
      throw new Error('Managed runtime update coordinator is not running');
    }
    const targetVersion = this.manager.getTargetVersion(name);
    const key = `${name}:${targetVersion}`;
    if (this.attempted.has(key) || this.queued.has(name)) return;
    this.attempted.add(key);
    this.queued.add(name);
    this.drainPromise ??= this.drain();
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.controller.abort();
    await this.waitForIdle();
  }

  async waitForIdle(): Promise<void> {
    while (this.drainPromise) {
      await this.drainPromise;
    }
  }

  private async drain(): Promise<void> {
    try {
      while (!this.stopped) {
        const name = this.queued.values().next().value;
        if (!name) return;
        this.queued.delete(name);
        try {
          const targetVersion = this.manager.getTargetVersion(name);
          this.logger.debug(
            `[managed-runtime] Background update started for ${name}@${targetVersion}`
          );
          await this.manager.ensureCurrentRuntime(name, { signal: this.controller.signal });
          await this.manager.pruneSupersededVersions(name);
          this.logger.debug(
            `[managed-runtime] Background update completed for ${name}@${targetVersion}`
          );
        } catch (error) {
          if (this.controller.signal.aborted) return;
          const diagnostics = this.manager.getDiagnostics(name);
          const errorMessage = formatManagedRuntimeFailureMessage(error);
          this.logger.error(
            `[managed-runtime] Background update failed for ${name}: ${errorMessage}`
          );
          captureCli(
            'managed_runtime/install_failed',
            {
              runtime_name: name,
              runtime_version: diagnostics.version,
              platform_arch: diagnostics.platformArch,
              runtime_base_host: diagnostics.runtimeBaseHost,
              proxy_env_present: diagnostics.proxyEnvPresent,
              proxy_configured_for_runtime_url: diagnostics.proxyConfiguredForRuntimeUrl,
              source: 'background_update',
              reason: classifyManagedRuntimeFailureReason(error),
              error_message: truncateAnalyticsString(errorMessage),
            },
            { tier: 'A' }
          );
        }
      }
    } finally {
      this.drainPromise = null;
      if (!this.stopped && this.queued.size > 0) {
        this.drainPromise = this.drain();
      }
    }
  }
}

let sharedCoordinator: ManagedRuntimeUpdateCoordinator | undefined;

export function configureManagedRuntimeUpdateCoordinator(options: {
  manager: ManagedRuntimeUpdateManager;
  logger: Pick<Logger, 'debug' | 'error'>;
}): ManagedRuntimeUpdateCoordinator {
  if (sharedCoordinator) {
    throw new Error('Managed runtime update coordinator is already configured');
  }
  sharedCoordinator = new ManagedRuntimeUpdateCoordinator(options.manager, options.logger);
  return sharedCoordinator;
}

export function getManagedRuntimeUpdateCoordinator(): ManagedRuntimeUpdateCoordinator {
  if (!sharedCoordinator) {
    throw new Error('Managed runtime update coordinator is not configured');
  }
  return sharedCoordinator;
}
