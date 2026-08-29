import { describe, expect, it } from "vitest";
import { workspaceTileHue, workspaceTileStyle } from "../src/shell/workspace-tile";

/** WCAG relative luminance of an sRGB channel triple. Computed here from the
 * published formula, independently of the helper's own math. */
function luminance(red: number, green: number, blue: number): number {
  const linear = (channel: number): number => {
    const scaled = channel / 255;
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = hue / 60;
  const second = chroma * (1 - Math.abs((sector % 2) - 1));
  const base = lightness - chroma / 2;
  const channels: [number, number, number] = sector < 1 ? [chroma, second, 0]
    : sector < 2 ? [second, chroma, 0]
    : sector < 3 ? [0, chroma, second]
    : sector < 4 ? [0, second, chroma]
    : sector < 5 ? [second, 0, chroma]
    : [chroma, 0, second];
  return [
    Math.round((channels[0] + base) * 255),
    Math.round((channels[1] + base) * 255),
    Math.round((channels[2] + base) * 255),
  ];
}

describe("workspaceTileStyle", () => {
  it("is deterministic per id", () => {
    expect(workspaceTileStyle("ws-a")).toEqual(workspaceTileStyle("ws-a"));
    expect(workspaceTileStyle("ws-a").background).not.toBe(workspaceTileStyle("ws-b").background);
  });

  it("paints one solid pastel, no gradient", () => {
    const { background } = workspaceTileStyle("ws-a");
    expect(background).toMatch(/^hsl\(\d+ 52% 80%\)$/u);
    expect(background).not.toContain("gradient");
  });

  it("keeps the dark ink past WCAG AA on every hue", () => {
    for (let hue = 0; hue < 360; hue += 1) {
      const [red, green, blue] = hslToRgb(hue, 0.52, 0.8);
      const tile = luminance(red, green, blue);
      const ink = luminance(11, 16, 32);
      const ratio = (Math.max(tile, ink) + 0.05) / (Math.min(tile, ink) + 0.05);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("spreads ids across the wheel", () => {
    const hues = new Set<number>();
    for (let index = 0; index < 200; index += 1) hues.add(workspaceTileHue(`ws-${String(index)}`));
    expect(hues.size).toBeGreaterThan(100);
  });
});
