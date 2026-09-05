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
  /** The sold-out server type this machine stands in for, or null when the
   * machine is offered in its own right.
   *
   * A vendor sells more than one line. Hetzner prices its cost-optimized line
   * (cx) at about a quarter of its regular line (cpx), and sells out of it
   * often. When a catalog entry has no stock in a location, the provider
   * offers the regular type with the same RAM in that SAME location and names
   * the entry it replaces here. The card then says why it costs four times as
   * much, instead of the entry disappearing with no word.
   *
   * The value is the sold-out type's own name, for example "cx33". The
   * location is not repeated: a stand-in never leaves the location it stands
   * in for, and `location` already carries it. */
  standsInFor: string | null;
}
