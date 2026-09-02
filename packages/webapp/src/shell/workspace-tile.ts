/** A workspace's generated visual fingerprint. The 5×5 bitmap mirrors its
 * first two columns around the center, so it stays legible at the rail's 35px
 * size instead of dissolving into random noise. */
export type WorkspaceSigil = {
  background: string;
  foreground: string;
  cells: ReadonlyArray<readonly [x: number, y: number]>;
};

/** FNV-1a, 32-bit. Chosen for spreading short ids across the generator, not for
 * any security property. */
function hashWorkspaceId(workspaceId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < workspaceId.length; index += 1) {
    hash = Math.imul(hash ^ workspaceId.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash;
}

export function workspaceTileHue(workspaceId: string): number {
  return hashWorkspaceId(workspaceId) % 360;
}

/** One step of a seeded linear congruential generator. It gives the bitmap
 * enough independent values without relying on runtime randomness or storage. */
function nextSeed(seed: number): number {
  return (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
}

export function workspaceSigil(workspaceId: string): WorkspaceSigil {
  const hash = hashWorkspaceId(workspaceId);
  let seed = hash;

  // Rank the 15 cells in the left half plus center column. Selecting a bounded
  // number avoids both nearly-empty marks and solid, indistinguishable blocks.
  const candidates = Array.from({ length: 15 }, (_, index) => {
    seed = nextSeed(seed);
    return { index, rank: seed };
  }).sort((left, right) => left.rank - right.rank);

  seed = nextSeed(seed);
  const filledCount = 6 + (seed % 5);
  const sourceCells = candidates.slice(0, filledCount);
  const cells: Array<readonly [number, number]> = [];

  for (const { index } of sourceCells) {
    const x = index % 3;
    const y = Math.floor(index / 3);
    cells.push([x, y]);
    if (x < 2) cells.push([4 - x, y]);
  }

  const hue = hash % 360;
  const foregroundHue = (hue + 28 + ((hash >>> 16) % 45)) % 360;
  return {
    background: `hsl(${String(hue)} 34% 18%)`,
    foreground: `hsl(${String(foregroundHue)} 78% 72%)`,
    cells,
  };
}
