import type { LodyAuthClient } from './auth';

let registered: LodyAuthClient | null = null;

export function registerAuthClient(client: LodyAuthClient): void {
  registered = client;
}

export function getRegisteredAuthClient(): LodyAuthClient | null {
  return registered;
}
