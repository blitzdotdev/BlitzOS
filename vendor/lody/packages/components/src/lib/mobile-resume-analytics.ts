import { deferredPostHog } from './deferred-posthog';
import { capturePostHogEvent, type PostHogAnalyticsProperties } from './posthog-analytics';

/**
 * Singleton-bound PostHog capture for the Capacitor shell's app-level lifecycle
 * code (apps/mobile/src/resume-recovery.ts), which runs OUTSIDE the React tree
 * and therefore has no `usePostHog()` client to pass.
 *
 * Lives in @lody/components (not the mobile app) on purpose: `posthog-js` is a
 * dependency of this package, not of apps/mobile. Importing the singleton here
 * keeps the dependency where it already resolves and lets the mobile shell stay
 * dependency-thin. Rejected importing `posthog-js` directly from apps/mobile:
 * it is only a transitive dep there, so the import fails to resolve/typecheck.
 *
 * Side-effect-only: never throws into product/recovery code.
 */
export function capturePostHogSingleton(
  eventName: string,
  properties?: PostHogAnalyticsProperties
): void {
  try {
    capturePostHogEvent(deferredPostHog, eventName, properties);
  } catch {
    // Analytics must never break mobile resume/recovery.
  }
}
