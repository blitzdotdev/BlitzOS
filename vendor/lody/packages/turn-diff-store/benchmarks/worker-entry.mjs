import { register } from 'tsx/esm/api';

register();
const { runTurnDiffStoreWorker } = await import('../src/worker.ts');
runTurnDiffStoreWorker();
