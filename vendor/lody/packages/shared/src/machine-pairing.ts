export const MACHINE_PAIRING_TOKEN_PREFIX = 'lody_pair_';
export const MACHINE_PAIRING_TTL_MS = 30 * 60 * 1000;

export type MachinePairingStatus = 'pending' | 'claimed' | 'registered' | 'cancelled' | 'expired';

export type MachinePairingView = {
  id: string;
  status: MachinePairingStatus;
  machineId?: string;
  machineName?: string;
  expiresAt: number;
};

export type MachinePairingCreateResponse = {
  request: MachinePairingView;
  token: string;
};

export type MachinePairingExchangeResponse = {
  apiKey: string;
};
