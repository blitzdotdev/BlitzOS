import { terminalPastePayload } from './terminal-paste';

export type SessionInputWriter = (payload: string) => boolean;

export interface SessionTextDelivery {
  bracketedPasteMode: boolean;
  input: SessionInputWriter;
}

export function pasteToSession(text: string, delivery: SessionTextDelivery): boolean {
  if (text.length === 0) return false;
  return delivery.input(terminalPastePayload(text, delivery.bracketedPasteMode));
}
