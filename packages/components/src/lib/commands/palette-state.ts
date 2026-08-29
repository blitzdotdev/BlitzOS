import { atom, useAtom } from 'jotai';
import { jotaiStore } from '../utils';

export const commandPaletteOpenAtom = atom(false);

export function useCommandPaletteState(): readonly [boolean, (open: boolean) => void] {
  const [open, setOpen] = useAtom(commandPaletteOpenAtom, { store: jotaiStore });
  return [open, setOpen];
}

/** Read/write outside React (e.g. inside a command's `run` handler). */
export function getCommandPaletteOpen(): boolean {
  return jotaiStore.get(commandPaletteOpenAtom);
}
export function setCommandPaletteOpen(open: boolean): void {
  jotaiStore.set(commandPaletteOpenAtom, open);
}
