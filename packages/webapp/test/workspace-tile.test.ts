import { describe, expect, it } from "vitest";
import { workspaceSigil, workspaceTileHue } from "../src/shell/workspace-tile";

function cellKey([x, y]: readonly [number, number]): string {
  return `${String(x)}:${String(y)}`;
}

describe("workspaceSigil", () => {
  it("is deterministic per workspace id", () => {
    expect(workspaceSigil("ws-a")).toEqual(workspaceSigil("ws-a"));
    expect(workspaceSigil("ws-a")).not.toEqual(workspaceSigil("ws-b"));
  });

  it("builds a mirrored 5 by 5 bitmap with bounded density", () => {
    for (let index = 0; index < 200; index += 1) {
      const { cells } = workspaceSigil(`ws-${String(index)}`);
      const keys = new Set(cells.map(cellKey));
      expect(keys.size).toBe(cells.length);
      expect(cells.length).toBeGreaterThanOrEqual(7);
      expect(cells.length).toBeLessThanOrEqual(20);

      for (const [x, y] of cells) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(4);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(4);
        expect(keys.has(cellKey([4 - x, y]))).toBe(true);
      }
    }
  });

  it("creates a dark base and bright companion color without gradients", () => {
    const sigil = workspaceSigil("ws-a");
    expect(sigil.background).toMatch(/^hsl\(\d+ 34% 18%\)$/u);
    expect(sigil.foreground).toMatch(/^hsl\(\d+ 78% 72%\)$/u);
    expect(sigil.background).not.toContain("gradient");
    expect(sigil.foreground).not.toContain("gradient");
  });

  it("spreads ids across hues and bitmap shapes", () => {
    const hues = new Set<number>();
    const patterns = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      const workspaceId = `ws-${String(index)}`;
      hues.add(workspaceTileHue(workspaceId));
      patterns.add(workspaceSigil(workspaceId).cells.map(cellKey).sort().join(","));
    }
    expect(hues.size).toBeGreaterThan(100);
    expect(patterns.size).toBeGreaterThan(180);
  });
});
