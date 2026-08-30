import { describe, expect, it } from 'vitest';
import { collectBootDiagnostics } from '../src/lib/boot-failure';

describe('collectBootDiagnostics', () => {
  it('formats an Error using its name + message', () => {
    const diag = collectBootDiagnostics(new TypeError('foo is not a function'));
    expect(diag.message).toBe('TypeError: foo is not a function');
    expect(diag.copyableText.startsWith('TypeError: foo is not a function')).toBe(true);
  });

  it('passes string errors through verbatim', () => {
    expect(collectBootDiagnostics('boom').message).toBe('boom');
  });

  it('handles null and undefined without throwing', () => {
    expect(collectBootDiagnostics(null).message).toBe('Unknown error');
    expect(collectBootDiagnostics(undefined).message).toBe('Unknown error');
  });

  it('JSON-stringifies plain object errors', () => {
    const diag = collectBootDiagnostics({ code: 'EBOOM', detail: 'broken' });
    expect(diag.message).toContain('EBOOM');
    expect(diag.message).toContain('broken');
  });

  it('falls back to String() when JSON.stringify throws (circular)', () => {
    const circular: Record<string, unknown> = { name: 'cycle' };
    circular.self = circular;
    const diag = collectBootDiagnostics(circular);
    // Either the stringify fallback or String(circular) — just confirm it didn't throw.
    expect(typeof diag.message).toBe('string');
    expect(diag.message.length).toBeGreaterThan(0);
  });

  it('includes the stack when the Error has one', () => {
    const err = new Error('explode');
    err.stack = 'Error: explode\n    at someFn (file.ts:1:1)\n    at other (file.ts:2:2)';
    const diag = collectBootDiagnostics(err);
    expect(diag.details).toContain('Stack:');
    expect(diag.details).toContain('at someFn');
    expect(diag.copyableText).toContain('at someFn');
  });

  it('appends every buildInfo entry to the details block', () => {
    const diag = collectBootDiagnostics(new Error('x'), {
      buildInfo: { Runtime: 'electron', Commit: 'abc123', BuildDate: '2026-05-28' },
    });
    expect(diag.details).toContain('Runtime: electron');
    expect(diag.details).toContain('Commit: abc123');
    expect(diag.details).toContain('BuildDate: 2026-05-28');
  });

  it('round-trips the optional hint into the returned diagnostics', () => {
    expect(collectBootDiagnostics(new Error('x'), { hint: 'try a reload' }).hint).toBe(
      'try a reload'
    );
    expect(collectBootDiagnostics(new Error('x')).hint).toBe('');
  });

  it('copyableText starts with the message and then has the details block', () => {
    const diag = collectBootDiagnostics(new Error('hi'), {
      buildInfo: { Foo: 'bar' },
    });
    // The message must appear before the details (the copy contract relied on
    // by the recovery flow puts the headline error first for skimming).
    const messageIdx = diag.copyableText.indexOf(diag.message);
    const detailsIdx = diag.copyableText.indexOf('Foo: bar');
    expect(messageIdx).toBe(0);
    expect(detailsIdx).toBeGreaterThan(messageIdx);
  });

  it('records an ISO timestamp in the details block', () => {
    const diag = collectBootDiagnostics(new Error('x'));
    expect(diag.details).toMatch(/Time: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
