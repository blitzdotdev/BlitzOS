import { ConvexHttpClient } from 'convex/browser';
import { api } from '@lody/cloud-api';
import { LODY_AUTH_URL } from '@/utils/const';
import type { ExportUsageBundle } from './types';

export async function fetchWorkspaceUsageBundle(args: {
  workspaceId: string;
  cliToken: string;
}): Promise<ExportUsageBundle> {
  const convexUrl = LODY_AUTH_URL?.trim();
  if (!convexUrl) {
    throw new Error('LODY_AUTH_URL is not configured.');
  }

  const client = new ConvexHttpClient(convexUrl);

  const [summary, day, week, month, total] = await Promise.all([
    client.query(api.usage.getWorkspaceUsageSummaryBundleFromCliToken, {
      workspaceId: args.workspaceId,
      cliToken: args.cliToken,
    }),
    client.query(api.usage.getWorkspaceUsageTimelineFromCliToken, {
      workspaceId: args.workspaceId,
      cliToken: args.cliToken,
      range: 'day',
    }),
    client.query(api.usage.getWorkspaceUsageTimelineFromCliToken, {
      workspaceId: args.workspaceId,
      cliToken: args.cliToken,
      range: 'week',
    }),
    client.query(api.usage.getWorkspaceUsageTimelineFromCliToken, {
      workspaceId: args.workspaceId,
      cliToken: args.cliToken,
      range: 'month',
    }),
    client.query(api.usage.getWorkspaceUsageTimelineFromCliToken, {
      workspaceId: args.workspaceId,
      cliToken: args.cliToken,
      range: 'total',
    }),
  ]);

  return {
    summary,
    timelines: {
      day,
      week,
      month,
      total,
    },
  };
}
