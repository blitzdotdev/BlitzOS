import type { GlobalShortcutTriggeredPayload } from '@lody/shared';
import { capturePostHogEvent, type PostHogAnalyticsClient } from '@/lib/posthog-analytics';
import { getPlatform, getRuntime } from './platform';
import type { Platform, Runtime } from './types';

export type ShortcutUsageSource = 'keyboard' | 'global_shortcut';

export type ShortcutUsagePayload = {
  commandId: string;
  binding: string | null;
  source: ShortcutUsageSource;
  runtime: Runtime;
  platform: Platform;
  isUserOverride: boolean;
};

export type ShortcutUsageAnalyticsHandler = (payload: ShortcutUsagePayload) => void;

export type { GlobalShortcutTriggeredPayload };

export function createShortcutUsagePayload(input: {
  commandId: string;
  binding: string | null;
  source: ShortcutUsageSource;
  isUserOverride: boolean;
}): ShortcutUsagePayload {
  return {
    ...input,
    runtime: getRuntime(),
    platform: getPlatform(),
  };
}

export function captureShortcutUsage(
  postHog: PostHogAnalyticsClient | null | undefined,
  payload: ShortcutUsagePayload
): void {
  capturePostHogEvent(postHog, 'command/shortcut_used', {
    command_id: payload.commandId,
    binding: payload.binding,
    source: payload.source,
    runtime: payload.runtime,
    platform: payload.platform,
    is_user_override: payload.isUserOverride,
  });
}
