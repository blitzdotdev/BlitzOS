import { describe, expect, it } from "vitest";
import { workspaceTileStyle } from "../src/shell/workspace-tile.js";

/** WCAG 2.2 relative luminance, written out here rather than imported, so the
 * contrast claim is checked against the published formula and not against the
 * helper's own arithmetic. */
function luminance(red: number, green: number, blue: number): number {
  const channel = (value: number) => {
    const unit = value / 255;
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

function contrast(one: number, other: number): number {
  return (Math.max(one, other) + 0.05) / (Math.min(one, other) + 0.05);
}

function colors(value: string): number[][] {
  return [...value.matchAll(/rgb\((\d+) (\d+) (\d+)\)/gu)]
    .map((match) => [Number(match[1]), Number(match[2]), Number(match[3])]);
}

function inkOverTile(workspaceId: string): number {
  const style = workspaceTileStyle(workspaceId);
  const stops = colors(style.background);
  expect(stops).toHaveLength(2);
  const tile = stops
    .map(([red, green, blue]) => luminance(red!, green!, blue!))
    .reduce((total, value) => total + value, 0) / stops.length;
  const ink = colors(style.color);
  expect(ink).toHaveLength(1);
  const [red, green, blue] = ink[0]!;
  return contrast(luminance(red!, green!, blue!), tile);
}

const ids = Array.from({ length: 600 }, (_, index) => `workspace-${String(index)}`);

describe("workspaceTileStyle", () => {
  it("paints the same tile for the same id, every time", () => {
    expect(workspaceTileStyle("workspace-one"))
      .toEqual(workspaceTileStyle("workspace-one"));
    expect(workspaceTileStyle("workspace-one").background)
      .toBe(workspaceTileStyle("workspace-one").background);
  });

  it("is a two-stop gradient, and the stops are two different hues", () => {
    const style = workspaceTileStyle("design-team");
    expect(style.background).toMatch(
      /^linear-gradient\(135deg, rgb\(\d+ \d+ \d+\) 0%, rgb\(\d+ \d+ \d+\) 100%\)$/u,
    );
    const [start, end] = colors(style.background);
    expect(start).not.toEqual(end);
  });

  it("spreads a stripful of workspaces around the wheel", () => {
    // 360 hues, so ids collide eventually; a strip holds tens, not hundreds.
    const strip = ids.slice(0, 60);
    const backgrounds = new Set(strip.map((id) => workspaceTileStyle(id).background));
    expect(backgrounds.size).toBeGreaterThanOrEqual(50);
  });

  it("picks an ink that clears WCAG AA over the gradient it painted", () => {
    const ratios = ids.map((id) => inkOverTile(id));
    expect(Math.min(...ratios)).toBeGreaterThanOrEqual(4.5);
  });

  it("uses both inks, so the luminance choice is a real choice", () => {
    const inks = new Set(ids.map((id) => workspaceTileStyle(id).color));
    expect(inks.size).toBe(2);
  });
});
