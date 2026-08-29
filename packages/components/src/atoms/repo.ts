import { atom } from 'jotai';
import { activeWorkspaceRuntimeAtom } from './runtime';

export const repoAtom = atom((get) => get(activeWorkspaceRuntimeAtom)?.repo ?? null);
