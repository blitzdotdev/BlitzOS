/** What a machine costs the customer for one month. */
export interface MachinePrice {
  /** The gross amount. The customer pays this, tax included. */
  amount: number;
  /** The ISO 4217 code, for example "EUR". Vendors do not all bill in euro. */
  currency: string;
}

export interface MachineType {
  id: string;
  providerId: string;
  supportsVolumes: boolean;
  name: string;
  cpuCores: number;
  memGb: number;
  diskGb: number;
  arch: "x86" | "arm64";
  location: string;
  /** Absent when the provider publishes no monthly price. The microVM pool
   * and AWS publish none, so the create page shows a price for Hetzner only. */
  monthlyPrice?: MachinePrice;
}
