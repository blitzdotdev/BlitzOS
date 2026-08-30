import {
  type LiveActivityConversationItem,
  type LiveActivityPermissionAlert,
  type LiveActivityStatusCounts,
  parseGitHubPrNumber,
  type PermissionRequestKind,
  SessionId,
  type SessionPullRequestLegacyMetaFields,
  type SessionPullRequestMeta,
  WorkspaceId,
} from '@lody/shared';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '@lody/cloud-api';
import { Logger } from '@/utils/logger';

export type SessionCompletionNotificationInput = {
  sessionId: SessionId;
  occurrenceId: string;
  sessionTitle: string | null | undefined;
  pullRequests?: SessionPullRequestMeta[];
  workspaceId: WorkspaceId;
  workspaceSlug: string;
  userId: string;
};

export type PermissionRequestNotificationInput = {
  sessionId: SessionId;
  sessionTitle: string | null | undefined;
  workspaceId: WorkspaceId;
  workspaceSlug: string;
  userId: string;
  requestId: string;
  toolCallId: string;
  toolTitle: string | null | undefined;
  toolKind: string | null | undefined;
  requestKind?: PermissionRequestKind;
};

export type LiveActivitySummaryNotificationInput = {
  activityId: string;
  workspaceId: WorkspaceId;
  userId: string;
  totalCount: number;
  statusCounts: LiveActivityStatusCounts;
  items: LiveActivityConversationItem[];
  updatedAt: number;
  permissionAlert?: LiveActivityPermissionAlert;
};

export type LiveActivitySummarySyncResult =
  | { sent: true; ended: boolean }
  | { sent: false; reason?: string };

export type NotificationServiceConfig = {
  convexUrl: string;
  cliToken: string;
  logger: Logger;
};

export class NotificationService {
  private client: ConvexHttpClient;
  private cliToken: string;
  private logger: Logger;

  constructor(config: NotificationServiceConfig) {
    this.client = new ConvexHttpClient(config.convexUrl);
    this.cliToken = config.cliToken;
    this.logger = config.logger;
  }

  get enabled(): boolean {
    return true;
  }

  async notifySessionCompleted(input: SessionCompletionNotificationInput): Promise<void> {
    try {
      const pullRequests = input.pullRequests?.flatMap((pr) => {
        const legacy = pr as SessionPullRequestLegacyMetaFields;
        const number = legacy.number ?? parseGitHubPrNumber(pr.url);
        if (typeof number !== 'number' || !Number.isFinite(number)) {
          return [];
        }
        return [
          {
            number,
            status: pr.status,
            ...(legacy.reportedAt ? { reportedAt: legacy.reportedAt } : {}),
          },
        ];
      });

      await this.client.action(api.notifications.notifySessionCompleted, {
        cliToken: this.cliToken,
        sessionId: input.sessionId,
        occurrenceId: input.occurrenceId,
        sessionTitle: input.sessionTitle ?? undefined,
        pullRequests,
        workspaceId: input.workspaceId,
        workspaceSlug: input.workspaceSlug,
        userId: input.userId,
      });
    } catch (error) {
      this.logger.debug(
        `[notifications] Failed to send completion notification for ${input.sessionId}: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  async notifyPermissionRequested(input: PermissionRequestNotificationInput): Promise<void> {
    try {
      await this.client.action(api.notifications.notifyPermissionRequested, {
        cliToken: this.cliToken,
        sessionId: input.sessionId,
        requestId: input.requestId,
        toolCallId: input.toolCallId,
        toolTitle: input.toolTitle ?? undefined,
        toolKind: input.toolKind ?? undefined,
        requestKind: input.requestKind,
        sessionTitle: input.sessionTitle ?? undefined,
        workspaceId: input.workspaceId,
        workspaceSlug: input.workspaceSlug,
        userId: input.userId,
      });
    } catch (error) {
      this.logger.debug(
        `[notifications] Failed to send permission request notification for ${input.sessionId}: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  async recordPermissionRequested(input: PermissionRequestNotificationInput): Promise<void> {
    try {
      await this.client.action(api.notifications.recordPermissionRequested, {
        cliToken: this.cliToken,
        sessionId: input.sessionId,
        requestId: input.requestId,
        toolCallId: input.toolCallId,
        toolTitle: input.toolTitle ?? undefined,
        toolKind: input.toolKind ?? undefined,
        requestKind: input.requestKind,
        sessionTitle: input.sessionTitle ?? undefined,
        workspaceId: input.workspaceId,
        workspaceSlug: input.workspaceSlug,
        userId: input.userId,
      });
    } catch (error) {
      this.logger.debug(
        `[notifications] Failed to record permission request for ${input.sessionId}: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  async resolvePermissionRequested(input: PermissionRequestNotificationInput): Promise<void> {
    try {
      await this.client.action(api.notifications.resolvePermissionRequested, {
        cliToken: this.cliToken,
        sessionId: input.sessionId,
        requestId: input.requestId,
        toolCallId: input.toolCallId,
        workspaceId: input.workspaceId,
        userId: input.userId,
      });
    } catch (error) {
      this.logger.debug(
        `[notifications] Failed to resolve permission notification for ${input.sessionId}: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  async syncLiveActivitySummary(
    input: LiveActivitySummaryNotificationInput
  ): Promise<LiveActivitySummarySyncResult> {
    try {
      const response = await this.client.action(api.notifications.syncLiveActivitySummary, {
        cliToken: this.cliToken,
        workspaceId: input.workspaceId,
        userId: input.userId,
        activityId: input.activityId,
        totalCount: input.totalCount,
        statusCounts: input.statusCounts,
        items: input.items,
        updatedAt: input.updatedAt,
        ...(input.permissionAlert ? { permissionAlert: input.permissionAlert } : {}),
      });
      return response.sent
        ? { sent: true, ended: response.ended === true }
        : { sent: false, reason: response.reason };
    } catch (error) {
      this.logger.debug(
        `[notifications] Failed to sync live activity summary for ${input.activityId}: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
      return { sent: false, reason: 'request_failed' };
    }
  }
}
