import { describe, expect, it } from 'vitest';
import { TASK_IMAGE_MAX_SIZE_BYTES } from '@lody/shared';
import { validateTaskImageFile } from '../src/lib/task-image-upload';

describe('validateTaskImageFile', () => {
  it('accepts supported image files', () => {
    expect(
      validateTaskImageFile(new File(['png'], 'diagram.png', { type: 'image/png' }))
    ).toBeNull();
    expect(
      validateTaskImageFile(new File(['jpeg'], 'photo.JPG', { type: 'image/jpeg' }))
    ).toBeNull();
  });

  it('rejects mismatched types, unsupported extensions, and empty files', () => {
    expect(validateTaskImageFile(new File(['png'], 'diagram.svg', { type: 'image/png' }))).toMatch(
      /extension/u
    );
    expect(
      validateTaskImageFile(new File(['svg'], 'diagram.png', { type: 'image/svg+xml' }))
    ).toMatch(/type/u);
    expect(validateTaskImageFile(new File([], 'empty.png', { type: 'image/png' }))).toMatch(
      /empty/u
    );
  });

  it('rejects images above the shared size limit', () => {
    const oversized = new File([new Uint8Array(TASK_IMAGE_MAX_SIZE_BYTES + 1)], 'oversized.png', {
      type: 'image/png',
    });
    expect(validateTaskImageFile(oversized)).toMatch(/<= 5MB/u);
  });
});
