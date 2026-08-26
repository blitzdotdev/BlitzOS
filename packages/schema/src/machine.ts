/** What one machine costs for one month, in the vendor's own currency. */
export interface MachinePrice {
  /** The amount for one month, as the vendor's own price list gives it. */
  amount: number;
  /** The ISO 4217 code, for example "EUR" or "USD". Vendors do not all bill
   * in euro. A card that assumes one lies about money. */
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
  /** The price to show, or null when this machine has none to show.
   * The field is required, so every provider must answer. It was optional
   * once, and silence let a provider ship a blank price with no decision
   * behind it. */
  monthlyPrice: MachinePrice | null;
}
