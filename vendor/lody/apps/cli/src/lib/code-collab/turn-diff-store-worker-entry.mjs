import { register } from 'tsx/esm/api';

register();
await import('./turn-diff-store-worker.ts');
