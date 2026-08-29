import { describe, expect, it } from 'vitest';
import { isCliVersionOutdated } from '../src/lib/machine-lifecycle-api';

describe('isCliVersionOutdated', () => {
  it('detects older major, minor, and patch versions', () => {
    expect(isCliVersionOutdated('1.2.3', '2.0.0')).toBe(true);
    expect(isCliVersionOutdated('1.2.3', '1.3.0')).toBe(true);
    expect(isCliVersionOutdated('1.2.3', '1.2.4')).toBe(true);
  });

  it('does not flag equal, newer, missing, or malformed versions', () => {
    expect(isCliVersionOutdated('1.2.3', '1.2.3')).toBe(false);
    expect(isCliVersionOutdated('1.2.4', '1.2.3')).toBe(false);
    expect(isCliVersionOutdated(undefined, '1.2.3')).toBe(false);
    expect(isCliVersionOutdated('dev', '1.2.3')).toBe(false);
  });

  it('treats a prerelease current version as older than the matching stable latest', () => {
    expect(isCliVersionOutdated('1.2.3-beta.1', '1.2.3')).toBe(true);
    expect(isCliVersionOutdated('1.2.3', '1.2.3-beta.1')).toBe(false);
  });
});
