/**
 * Web Worker that computes the underwater seabed point attributes off the main
 * thread (the dominant cold-start cost of the landing background). Pure math
 * only — three.js stays in the main bundle.
 */

import {
  computeTerrainAttributes,
  terrainTransferables,
  type TerrainParams,
} from './underwater-terrain-math';

export type TerrainWorkerRequest = {
  gen: number;
  pointBudget: number;
  params: TerrainParams;
};

export type TerrainWorkerResponse = {
  gen: number;
} & ReturnType<typeof computeTerrainAttributes>;

self.onmessage = (event: MessageEvent<TerrainWorkerRequest>) => {
  const { gen, pointBudget, params } = event.data;
  const attrs = computeTerrainAttributes(pointBudget, params);
  const response: TerrainWorkerResponse = { gen, ...attrs };
  (self as unknown as Worker).postMessage(response, terrainTransferables(attrs));
};
