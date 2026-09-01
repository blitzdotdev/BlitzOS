import { ConvexHttpClient } from 'convex/browser';
import { api } from '@lody/cloud-api';
import { Logger } from '@/utils/logger';
import type { CliType } from '@lody/shared';
import { PRICE_DATA } from './price';
import { SessionUsageUpdate } from 'acp-extension-core';
import { formatErrorMessage } from '@/utils/format-error';

export type UsageTrackingServiceConfig = {
  convexUrl: string;
  cliToken: string;
  logger: Logger;
};

export type RecordSessionUsageInput = {
  workspaceId: string;
  sessionId: string;
  acpSessionId: string;
  userId: string;
  machineId: string;
  cliType: CliType;
  update: SessionUsageUpdate;
};

type PendingKey = string;

type PendingState = {
  latestMeta: Omit<RecordSessionUsageInput, 'update'>;
  staged: SessionUsageUpdate | null;
  compacted: SessionUsageUpdate | null;
  inFlight: Promise<void> | null;
};

// Keep per-ACP-session accumulation isolated to avoid snapshot baseline resets
// when one Lody session is resumed as a brand new ACP session.
const toPendingKey = (
  input: Pick<RecordSessionUsageInput, 'workspaceId' | 'sessionId' | 'acpSessionId' | 'userId'>
): PendingKey => `${input.workspaceId}:${input.sessionId}:${input.acpSessionId}:${input.userId}`;

const cloneModelUsage = (
  modelUsage: SessionUsageUpdate['modelUsage']
): SessionUsageUpdate['modelUsage'] => {
  if (!modelUsage) return undefined;
  const cloned: NonNullable<SessionUsageUpdate['modelUsage']> = {};
  for (const [model, usage] of Object.entries(modelUsage)) {
    cloned[model] = { ...usage };
  }
  return cloned;
};

const cloneUsageUpdate = (update: SessionUsageUpdate): SessionUsageUpdate => ({
  sessionId: update.sessionId,
  usage: { ...update.usage },
  ...(update.modelUsage ? { modelUsage: cloneModelUsage(update.modelUsage) } : {}),
});

const mergeModelUsage = (
  base: SessionUsageUpdate['modelUsage'],
  delta: SessionUsageUpdate['modelUsage']
): SessionUsageUpdate['modelUsage'] => {
  const merged: NonNullable<SessionUsageUpdate['modelUsage']> = {};
  if (base) {
    for (const [model, usage] of Object.entries(base)) {
      merged[model] = { ...usage };
    }
  }
  if (!delta) {
    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  for (const [model, usage] of Object.entries(delta)) {
    const prev = merged[model];
    merged[model] = {
      inputTokens: (prev?.inputTokens ?? 0) + usage.inputTokens,
      outputTokens: (prev?.outputTokens ?? 0) + usage.outputTokens,
      cacheReadInputTokens: (prev?.cacheReadInputTokens ?? 0) + usage.cacheReadInputTokens,
      cacheCreationInputTokens:
        (prev?.cacheCreationInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0),
      reasoningOutputTokens:
        (prev?.reasoningOutputTokens ?? 0) + (usage.reasoningOutputTokens ?? 0),
      webSearchRequests: (prev?.webSearchRequests ?? 0) + (usage.webSearchRequests ?? 0),
      costUSD: (prev?.costUSD ?? 0) + (usage.costUSD ?? 0),
    };
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
};

const mergeUsageUpdate = (
  base: SessionUsageUpdate,
  delta: SessionUsageUpdate
): SessionUsageUpdate => ({
  sessionId: delta.sessionId,
  usage: {
    inputTokens: base.usage.inputTokens + delta.usage.inputTokens,
    outputTokens: base.usage.outputTokens + delta.usage.outputTokens,
    cacheReadInputTokens: base.usage.cacheReadInputTokens + delta.usage.cacheReadInputTokens,
    cacheCreationInputTokens:
      (base.usage.cacheCreationInputTokens ?? 0) + (delta.usage.cacheCreationInputTokens ?? 0),
    reasoningOutputTokens:
      (base.usage.reasoningOutputTokens ?? 0) + (delta.usage.reasoningOutputTokens ?? 0),
    contextWindow: delta.usage.contextWindow ?? base.usage.contextWindow,
  },
  modelUsage: mergeModelUsage(base.modelUsage, delta.modelUsage),
});

export class UsageTrackingService {
  private readonly client: ConvexHttpClient;
  private readonly cliToken: string;
  private readonly logger: Logger;
  private readonly pending = new Map<PendingKey, PendingState>();
  private readonly sessionToPendingKeys = new Map<string, Set<PendingKey>>();

  constructor(config: UsageTrackingServiceConfig) {
    this.client = new ConvexHttpClient(config.convexUrl);
    this.cliToken = config.cliToken;
    this.logger = config.logger;
  }

  recordSessionUsageUpdate(input: RecordSessionUsageInput): void {
    const key = toPendingKey(input);
    const update = this.calculatePrice(cloneUsageUpdate(input.update), input.cliType);
    const latestMeta = {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      acpSessionId: input.acpSessionId,
      userId: input.userId,
      machineId: input.machineId,
      cliType: input.cliType,
    } as const;

    const existing = this.pending.get(key);
    if (existing) {
      existing.latestMeta = latestMeta;
      this.applyUpdateToState(existing, input.cliType, update);
      return;
    }

    const state: PendingState = {
      latestMeta,
      staged: null,
      compacted: null,
      inFlight: null,
    };
    this.applyUpdateToState(state, input.cliType, update);
    this.pending.set(key, state);
    this.addPendingKeyToSession(input.sessionId, key);
  }

  async flushSessionUsage(sessionId: string): Promise<void> {
    const keys = [...(this.sessionToPendingKeys.get(sessionId) ?? [])];
    await Promise.all(keys.map((key) => this.flushKey(key)));
  }

  private async flushKey(key: PendingKey): Promise<void> {
    const state = this.pending.get(key);
    if (!state) return;

    if (state.inFlight) {
      await state.inFlight;
      const latest = this.pending.get(key);
      if (!latest) return;
      if (latest.staged || latest.compacted) {
        await this.flushKey(key);
      }
      return;
    }

    const snapshotMeta = { ...state.latestMeta };
    const snapshotUpdate = this.buildFinalUpdate(state);
    state.staged = null;
    state.compacted = null;

    if (!snapshotUpdate?.modelUsage) {
      this.logger.debug(
        `[usage] Skipping persist for session=${snapshotMeta.sessionId} acpSessionId=${snapshotMeta.acpSessionId}: missing modelUsage`
      );
      this.maybeCleanupPendingState(key);
      return;
    }

    const params = {
      cliToken: this.cliToken,
      workspaceId: snapshotMeta.workspaceId,
      sessionId: snapshotMeta.sessionId,
      acpSessionId: snapshotMeta.acpSessionId,
      userId: snapshotMeta.userId,
      machineId: snapshotMeta.machineId,
      cliType: snapshotMeta.cliType,
      usage: snapshotUpdate.usage,
      modelUsage: snapshotUpdate.modelUsage,
    };

    state.inFlight = this.client
      .mutation(api.usage.upsertSessionUsageFromCli, params)
      .then(() => undefined)
      .catch((error: unknown) => {
        this.logger.debug(
          `[usage] Failed to persist usage for session=${snapshotMeta.sessionId} acpSessionId=${snapshotMeta.acpSessionId}: ${formatErrorMessage(
            error
          )}`
        );
      })
      .finally(() => {
        const current = this.pending.get(key);
        if (!current) return;
        current.inFlight = null;
        this.maybeCleanupPendingState(key);
      });

    await state.inFlight;
  }

  private applyUpdateToState(
    state: PendingState,
    cliType: CliType,
    update: SessionUsageUpdate
  ): void {
    if (cliType === 'codex' && this.isCodexCompaction(update)) {
      if (state.staged) {
        state.compacted = state.compacted
          ? mergeUsageUpdate(state.compacted, state.staged)
          : cloneUsageUpdate(state.staged);
      }
      state.staged = update;
      return;
    }

    state.staged = update;
  }

  private buildFinalUpdate(state: PendingState): SessionUsageUpdate | null {
    if (!state.staged && !state.compacted) {
      return null;
    }
    if (!state.compacted) {
      return state.staged ? cloneUsageUpdate(state.staged) : null;
    }
    if (!state.staged) {
      return cloneUsageUpdate(state.compacted);
    }
    return mergeUsageUpdate(state.compacted, state.staged);
  }

  private isCodexCompaction(update: SessionUsageUpdate): boolean {
    return update.usage.inputTokens === 0 && update.usage.outputTokens === 0;
  }

  private addPendingKeyToSession(sessionId: string, key: PendingKey): void {
    const keys = this.sessionToPendingKeys.get(sessionId);
    if (keys) {
      keys.add(key);
      return;
    }
    this.sessionToPendingKeys.set(sessionId, new Set([key]));
  }

  private removePendingKeyFromSession(sessionId: string, key: PendingKey): void {
    const keys = this.sessionToPendingKeys.get(sessionId);
    if (!keys) return;
    keys.delete(key);
    if (keys.size === 0) {
      this.sessionToPendingKeys.delete(sessionId);
    }
  }

  private maybeCleanupPendingState(key: PendingKey): void {
    const state = this.pending.get(key);
    if (!state) return;
    if (state.inFlight) return;
    if (state.staged || state.compacted) return;

    this.pending.delete(key);
    this.removePendingKeyFromSession(state.latestMeta.sessionId, key);
  }

  private calculatePrice(update: SessionUsageUpdate, cliType: CliType): SessionUsageUpdate {
    switch (cliType) {
      case 'claude':
        return update;
      case 'codex':
      case 'kimi':
        if (!update.modelUsage) return update;
        for (const [model, usage] of Object.entries(update.modelUsage)) {
          let costUSD = 0;
          const modelName = model.split('/')[0];
          if (!modelName) continue;
          const price = PRICE_DATA[modelName];
          if (!price) {
            this.logger.debug(`${modelName} have not set price`);
            continue;
          }
          costUSD += usage.inputTokens * price.inputCostPerToken;
          costUSD +=
            (usage.outputTokens + (usage.reasoningOutputTokens || 0)) * price.outputCostPerToken;
          costUSD +=
            (usage.cacheReadInputTokens + (usage.cacheCreationInputTokens || 0)) *
            price.cacheReadInputTokenCost;
          usage.costUSD = costUSD;
        }
        return update;
      default:
        return update;
    }
  }
}
