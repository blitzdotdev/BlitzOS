import { describe, expect, it } from 'vitest';

import {
  collectDocExistenceValues,
  collectDocMetadataPatches,
  collectDocMetadataPatchesFromEntries,
} from '../src/lib/flock-existence';

describe('collectDocExistenceValues', () => {
  it('collects boolean existence updates, tracks cleared markers, and keeps the last value per doc', () => {
    const existenceByDocId = collectDocExistenceValues({
      events: [
        { key: ['m', 'machine-1', 'lastSeen'], value: 123 },
        { key: ['e', 'machine-1'], value: false },
        { key: ['e', 'machine-2'], value: false },
        { key: ['e', 'machine-2'], value: true },
        { key: ['e', 'machine-3'] },
        { key: ['e'] },
        { key: ['e', 42], value: false },
        { key: ['e', 'machine-3'], value: 'true' },
      ],
    });

    expect(existenceByDocId.get('machine-1')).toBe('deleted');
    expect(existenceByDocId.get('machine-2')).toBe('active');
    expect(existenceByDocId.get('machine-3')).toBe('missing');
    expect(existenceByDocId.size).toBe(3);
  });
});

describe('collectDocMetadataPatches', () => {
  it('collects field-level metadata patches per docId', () => {
    const patches = collectDocMetadataPatches({
      events: [
        { key: ['m', 'machine-1', 'lastSeen'], value: 1000 },
        { key: ['m', 'machine-1', 'name'], value: 'dev-box' },
        { key: ['m', 'session-1', 'status'], value: 'running' },
        { key: ['e', 'machine-1'], value: true }, // existence event, should be ignored
        { key: ['m', 'machine-1', 'lastSeen'], value: 2000 }, // later value overwrites
      ],
    });

    expect(patches.size).toBe(2);
    expect(patches.get('machine-1')).toEqual({ lastSeen: 2000, name: 'dev-box' });
    expect(patches.get('session-1')).toEqual({ status: 'running' });
  });

  it('collects whole-object metadata rows and lets later field patches override them', () => {
    const patches = collectDocMetadataPatches({
      events: [
        {
          key: ['m', 'machine-1'],
          value: { id: 'machine-1', name: 'dev-box', lastSeen: 1000 },
        },
        { key: ['m', 'machine-1', 'lastSeen'], value: 2000 },
      ],
    });

    expect(patches.get('machine-1')).toEqual({
      id: 'machine-1',
      name: 'dev-box',
      lastSeen: 2000,
    });
  });

  it('normalizes undefined values to null (matching loro-repo canonical shape)', () => {
    const patches = collectDocMetadataPatches({
      events: [
        { key: ['m', 'doc-1', 'deletedField'] }, // value is undefined
        { key: ['m', 'doc-1', 'name'], value: 'kept' },
      ],
    });

    expect(patches.size).toBe(1);
    expect(patches.get('doc-1')).toEqual({ deletedField: null, name: 'kept' });
    // Explicitly verify null, not undefined
    expect(patches.get('doc-1')!.deletedField).toBeNull();
  });

  it('skips events with invalid key shapes', () => {
    const patches = collectDocMetadataPatches({
      events: [
        { key: ['m', 'doc-1'], value: 'full-object' }, // only 2 parts, no field name
        { key: ['m'], value: 123 }, // too short
        { key: ['m', 123, 'field'], value: 'bad-docid' }, // non-string docId
        { key: ['m', 'doc-1', 456], value: 'bad-field' }, // non-string field
      ],
    });

    expect(patches.size).toBe(0);
  });
});

describe('collectDocMetadataPatchesFromEntries', () => {
  it('supports whole-object metadata rows returned by flock.scan()', () => {
    const patches = collectDocMetadataPatchesFromEntries([
      {
        key: ['m', 'machine-1'],
        value: { id: 'machine-1', name: 'dev-box', lastSeen: 1234 },
      },
      {
        key: ['m', 'machine-2', 'name'],
        value: 'ci-box',
      },
    ]);

    expect(patches.get('machine-1')).toEqual({
      id: 'machine-1',
      name: 'dev-box',
      lastSeen: 1234,
    });
    expect(patches.get('machine-2')).toEqual({
      name: 'ci-box',
    });
  });
});
