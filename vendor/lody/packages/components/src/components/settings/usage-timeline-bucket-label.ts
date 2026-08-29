import type { SettingsUsageTimelineBucket, SettingsUsageTimelineData } from './settings-data-cache';

const DAY_MS = 24 * 60 * 60 * 1000;

export function formatUsageTimelineBucketLabel(
  timeline: Pick<SettingsUsageTimelineData, 'range' | 'bucketSizeMs' | 'endMs'>,
  bucket: Pick<SettingsUsageTimelineBucket, 'bucketStartMs' | 'bucketLabel'>,
  timeFormatter: Intl.DateTimeFormat
): string {
  if (timeline.range !== 'day' || timeline.bucketSizeMs >= DAY_MS) {
    return bucket.bucketLabel;
  }

  const fullBucketEndMs = bucket.bucketStartMs + timeline.bucketSizeMs;
  const bucketEndMs =
    timeline.endMs >= bucket.bucketStartMs && timeline.endMs < fullBucketEndMs
      ? timeline.endMs
      : fullBucketEndMs;
  return timeFormatter.format(new Date(bucketEndMs));
}
