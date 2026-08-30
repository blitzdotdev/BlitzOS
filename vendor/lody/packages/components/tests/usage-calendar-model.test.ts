import { describe, expect, it } from 'vitest';
import {
  createUsageCalendarModel,
  createUsageHeatScale,
  createUsageSkylineLodyLogoTriangles,
  createUsageSkylineAscii,
  createUsageSkylineBinaryStl,
  getUsageSkylineViewport,
  USAGE_CALENDAR_CELLS,
  USAGE_CALENDAR_COLUMNS,
  USAGE_CALENDAR_ROWS,
  USAGE_HEAT_MIN_INTENSITY,
  type UsageCalendarData,
} from '../src/components/settings/usage-calendar-model';

const DAY_MS = 24 * 60 * 60 * 1000;
const START_MS = Date.UTC(2025, 6, 20); // Sunday

function createCalendar(overrides: Record<number, number> = {}): UsageCalendarData {
  return {
    startMs: START_MS,
    endMs: START_MS + (USAGE_CALENDAR_CELLS - 1) * DAY_MS,
    days: Array.from({ length: USAGE_CALENDAR_CELLS }, (_, index) => {
      const dayStartMs = START_MS + index * DAY_MS;
      return {
        dayStartMs,
        date: new Date(dayStartMs).toISOString().slice(0, 10),
        tokens: overrides[index] ?? 0,
        costUSD: 0,
        isFuture: false,
      };
    }),
  };
}

describe('usage calendar model', () => {
  it('keeps a stable Sunday-first 53 by 7 grid and assigns contribution levels', () => {
    const model = createUsageCalendarModel(createCalendar({ 0: 100, 1: 200, 2: 300, 3: 400 }));

    expect(model.cells).toHaveLength(USAGE_CALENDAR_CELLS);
    expect(model.weeks).toHaveLength(USAGE_CALENDAR_COLUMNS);
    expect(model.weeks.every((week) => week.length === USAGE_CALENDAR_ROWS)).toBe(true);
    expect(model.cells[0]).toMatchObject({ column: 0, row: 0, level: 1 });
    expect(model.cells[1]).toMatchObject({ column: 0, row: 1, level: 2 });
    expect(model.cells[2]).toMatchObject({ column: 0, row: 2, level: 3 });
    expect(model.cells[3]).toMatchObject({ column: 0, row: 3, level: 4 });
    expect(model.cells.at(-1)).toMatchObject({ column: 52, row: 6, level: 0 });
  });

  it('centers a recent active range in a minimum-width skyline viewport', () => {
    const model = createUsageCalendarModel(
      createCalendar({
        [43 * USAGE_CALENDAR_ROWS]: 100,
        [47 * USAGE_CALENDAR_ROWS]: 200,
        [52 * USAGE_CALENDAR_ROWS]: 300,
      })
    );
    model.weeks[52]![0]!.isFuture = true;

    expect(getUsageSkylineViewport(model)).toEqual({ centerX: 19, width: 44 });
  });

  it('keeps full-year and empty skylines in the complete 53-column viewport', () => {
    const fullYear = createUsageCalendarModel(
      createCalendar({ 0: 100, [USAGE_CALENDAR_CELLS - 1]: 200 })
    );
    const empty = createUsageCalendarModel(createCalendar());

    expect(getUsageSkylineViewport(fullYear)).toEqual({ centerX: 0, width: 53 });
    expect(getUsageSkylineViewport(empty)).toEqual({ centerX: 0, width: 53 });
  });

  it('matches gh-skyline stacking with intensity tops and future dates', () => {
    const model = createUsageCalendarModel(createCalendar({ 0: 100, 1: 400 }));
    model.cells[2]!.isFuture = true;
    model.weeks[0]![2]!.isFuture = true;
    const rows = createUsageSkylineAscii(model).split('\n');

    expect(rows).toHaveLength(USAGE_CALENDAR_ROWS);
    expect(rows.every((row) => row.length === USAGE_CALENDAR_COLUMNS)).toBe(true);
    expect(rows[0]?.[0]).toBe('.');
    expect(rows[5]?.[0]).toBe('╽');
    expect(rows[6]?.[0]).toBe('░');
  });

  it('encodes a printable base, Lody logo relief, and twelve triangles for each active column', () => {
    const model = createUsageCalendarModel(createCalendar({ 0: 100, 3: 400 }));
    const output = createUsageSkylineBinaryStl(model);
    const triangleCount = new DataView(output).getUint32(80, true);
    const header = new TextDecoder()
      .decode(new Uint8Array(output, 0, 80))
      .replaceAll(String.fromCharCode(0), '');

    expect(header).toBe('Lody usage skyline binary STL');
    expect(triangleCount).toBeGreaterThan(36);
    expect(output.byteLength).toBe(84 + triangleCount * 50);
  });

  it('keeps ordinary days distinguishable when one outlier day dwarfs the rest', () => {
    const overrides: Record<number, number> = { 0: 10_000_000 };
    for (let index = 1; index <= 20; index += 1) overrides[index] = index * 100;
    const model = createUsageCalendarModel(createCalendar(overrides));
    const scale = createUsageHeatScale(model);

    // Anchoring on the absolute max would put every ordinary day at the same floor.
    expect(scale.referenceValue).toBeLessThan(model.maxValue);
    expect(scale.intensity(model.maxValue)).toBe(1);
    expect(scale.intensity(2000)).toBeGreaterThan(scale.intensity(100));
    expect(scale.intensity(100)).toBeGreaterThan(USAGE_HEAT_MIN_INTENSITY);
  });

  it('reports zero intensity for days without usage and clamps above the reference', () => {
    const model = createUsageCalendarModel(createCalendar({ 0: 100, 1: 200, 2: 300 }));
    const scale = createUsageHeatScale(model);

    expect(scale.intensity(0)).toBe(0);
    expect(scale.intensity(-5)).toBe(0);
    expect(scale.intensity(Number.NaN)).toBe(0);
    expect(scale.intensity(scale.referenceValue * 4)).toBe(1);
  });

  it('falls back to a zero reference when no day has usage', () => {
    const scale = createUsageHeatScale(createUsageCalendarModel(createCalendar()));

    expect(scale.referenceValue).toBe(0);
    expect(scale.intensity(10)).toBe(0);
  });

  it('creates a finite raised Lody logo mesh for the STL base', () => {
    const triangles = createUsageSkylineLodyLogoTriangles();
    const coordinates = triangles.flatMap((triangle) => [
      ...triangle.a,
      ...triangle.b,
      ...triangle.c,
    ]);
    const depths = triangles.flatMap((triangle) => [triangle.a[1], triangle.b[1], triangle.c[1]]);

    expect(triangles.length).toBeGreaterThan(0);
    expect(coordinates.every(Number.isFinite)).toBe(true);
    expect(Math.min(...depths)).toBe(-0.8);
    expect(Math.max(...depths)).toBe(0);
  });
});
