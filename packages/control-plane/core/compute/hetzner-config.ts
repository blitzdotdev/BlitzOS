/** Hetzner configuration: the Worker vars this provider reads, the warnings it
 * raises about them, and the small pure helpers that parse a machine-type id.
 * Split out of `hetzner.ts` so the adapter itself stays under the 700-line
 * warn. Nothing here performs I/O. */
import { isNumber, isRecord, isString } from "../http.js";
import type { ProviderMachineType } from "./types.js";

export const HETZNER_USER_DATA_MAX_BYTES = 32 * 1024;
// Current Hetzner server-type names (for example cx22, cpx31, and cax11)
// are lowercase ASCII letters followed by decimal digits, with no dash.
export interface MachineSelection {
  type: string;
  location: string | null;
}

/** Splits a machine-type id at its last `@`: `cx23@hel1` is the server type
 * and the location. A type with no `@` names the account default location. */
export function machineId(value: string): MachineSelection {
  const separator = value.lastIndexOf("@");
  if (separator === -1) return { type: value, location: null };
  return { type: value.slice(0, separator), location: value.slice(separator + 1) };
}

export const SERVER_TYPE_NAME_PATTERN = /^[a-z]+\d+$/u;
export const LOCATION_NAME_PATTERN = /^[a-z0-9-]+$/u;
// Default catalog: two cost-optimized EU sizes in each of the three EU
// locations, then the two US-west types.
//
// Hetzner runs two catalogs by continent, and the split is not a preference.
// The EU locations (fsn1, hel1, nbg1) and sin sell the cx line and the second
// cpx generation (cpx12, cpx22, cpx32, cpx42, cpx52, cpx62). The US locations
// (ash, hil) sell neither: they sell the first cpx generation (cpx11, cpx21,
// cpx31, cpx41, cpx51) and nothing else shared. So a cheaper EU box needs a
// different type, not the same type in another region.
//
// Gross price each month, read live on 2026-09-05, one price for all three EU
// locations: cx23 6.49, cx33 9.99, cpx22 22.99, cpx32 41.99. cpx21@hil 10.99
// and cpx31@hil 20.49. That account bills in USD. The figures were once
// called euro in this comment, which is how the wrong sign reached the cards.
//
// The cx entries are the reason the EU rows exist: cx33 gives the same 4 cpu
// and 8 GB as cpx32 for about a quarter of the price. Hetzner sells out of the
// cx line often, so `hetznerCatalogWithStandIns` puts the RAM-equal cpx type
// in the same location in its place rather than dropping the row.
//
// Operators override the catalog with the HETZNER_MACHINE_TYPES Worker var.
// The catalog constrains what the create page offers; existing workspaces on
// other types keep working because ownership stays shape-based.
export const DEFAULT_HETZNER_MACHINE_TYPES: readonly string[] = [
  "cx23@nbg1",
  "cx33@nbg1",
  "cx23@fsn1",
  "cx33@fsn1",
  "cx23@hel1",
  "cx33@hel1",
  "cpx21@hil",
  "cpx31@hil",
];

/** Hetzner's own name for its cheap shared line: the cx and cax types. The
 * catalog never guesses a line from the id, because the vendor states it. */
export const HETZNER_COST_OPTIMIZED = "cost_optimized";
/** Hetzner's own name for its standard shared line: the cpx types. */
export const HETZNER_REGULAR_PURPOSE = "regular_purpose";

/** The stock image every Hetzner VM booted before golden images existed, and
 * the fallback whenever a configured snapshot cannot be used. */
export const HETZNER_STOCK_IMAGE = "ubuntu-24.04";
// A Hetzner image is either a system-image name (`ubuntu-24.04`) or the
// decimal id of a snapshot in this project.
const SERVER_IMAGE_PATTERN = /^[a-z0-9][a-z0-9.-]{0,63}$/u;

export interface HetznerMachineTypeCatalogWarning {
  event: "hetzner_machine_type_catalog_entry_rejected";
  entry: string;
  reason: string;
}

/** A configured golden image was refused, so the create fell back to stock
 * Ubuntu. The workspace still works; it just pays the full bootstrap again.
 * Silence here would hide a whole fleet quietly running the slow path. */
export interface HetznerServerImageWarning {
  event: "hetzner_server_image_rejected";
  location: string;
  image: string;
  reason: string;
}

/** Hetzner states the billing currency only in /v1/pricing. When that read
 * fails, every Hetzner card loses its price. The operator must hear why. */
export interface HetznerPriceCurrencyWarning {
  event: "hetzner_price_currency_unavailable";
  reason: string;
}

export type HetznerProviderWarning =
  | HetznerMachineTypeCatalogWarning
  | HetznerPriceCurrencyWarning
  | HetznerServerImageWarning;

export type HetznerWarningSink = (warning: HetznerProviderWarning) => void;

type HetznerCatalogWarningSink = (
  warning: HetznerMachineTypeCatalogWarning,
) => void;

/**
 * Parses the HETZNER_MACHINE_TYPES Worker var (comma-separated
 * "type@location" entries) into the machine-type catalog allowlist. An unset
 * or blank var keeps the default catalog. Malformed entries are skipped with
 * one structured warning each; they never crash the Worker.
 */
export function hetznerMachineTypeAllowlistFromEnv(
  raw: string | undefined,
  warn: HetznerCatalogWarningSink = () => {},
): ReadonlySet<string> {
  if (raw === undefined || raw.trim() === "") {
    return new Set(DEFAULT_HETZNER_MACHINE_TYPES);
  }
  const allowlist = new Set<string>();
  for (const segment of raw.split(",")) {
    const entry = segment.trim();
    if (entry === "") continue;
    const selected = machineId(entry);
    const valid = selected.location !== null
      && SERVER_TYPE_NAME_PATTERN.test(selected.type)
      && LOCATION_NAME_PATTERN.test(selected.location);
    if (!valid) {
      warn({
        event: "hetzner_machine_type_catalog_entry_rejected",
        entry,
        reason: 'expected "<server-type>@<location>" (for example "cpx21@hil")',
      });
      continue;
    }
    allowlist.add(entry);
  }
  return allowlist;
}

/**
 * Parses the HETZNER_SERVER_IMAGES Worker var into the golden-image map.
 *
 * Entries are comma-separated `location=image` pairs, and `*=image` sets the
 * default for locations with no entry of their own. `image` is a snapshot id
 * or a system-image name. An unset or blank var boots stock Ubuntu, which is
 * what every deployment did before golden images existed.
 *
 * Snapshots are per-project, so this map belongs to one credential scope. A
 * BYOK organization with its own Hetzner project has no entry here and boots
 * stock Ubuntu. That is correct, not a bug: its project holds no snapshot.
 */
export function hetznerServerImagesFromEnv(
  raw: string | undefined,
  warn: (warning: HetznerServerImageWarning) => void = () => {},
): ReadonlyMap<string, string> {
  const images = new Map<string, string>();
  if (raw === undefined || raw.trim() === "") return images;
  for (const segment of raw.split(",")) {
    const entry = segment.trim();
    if (entry === "") continue;
    const separator = entry.indexOf("=");
    const location = separator === -1 ? "" : entry.slice(0, separator).trim();
    const image = separator === -1 ? "" : entry.slice(separator + 1).trim();
    const validLocation = location === "*" || LOCATION_NAME_PATTERN.test(location);
    if (!validLocation || !SERVER_IMAGE_PATTERN.test(image)) {
      warn({
        event: "hetzner_server_image_rejected",
        location,
        image,
        reason: 'expected "<location>=<image>" (for example "hel1=163000001" or "*=ubuntu-24.04")',
      });
      continue;
    }
    images.set(location, image);
  }
  return images;
}


/** One server type Hetzner offers in one location, with the line it belongs
 * to. `category` is Hetzner's own field, so nothing here reads a line out of
 * an id. */
export interface HetznerOffer {
  machineType: ProviderMachineType;
  category: string;
}

/** What the catalog needs to know about a type that has no stock anywhere:
 * which line it belongs to, and the size a stand-in has to match. */
export interface HetznerTypeSpec {
  category: string;
  cpuCores: number;
  memGb: number;
}

/** Sorts by price, cheapest first. A type with no price sorts last: an
 * unpriced stand-in is the one a customer can least afford to be handed. */
function byPrice(offer: HetznerOffer): number {
  return offer.machineType.monthlyPrice?.amount ?? Number.POSITIVE_INFINITY;
}

/**
 * The catalog the create page sees: every allow-listed entry Hetzner has in
 * stock, plus a stand-in for each cost-optimized entry it has sold out.
 *
 * WHY A STAND-IN AT ALL. An entry with no stock used to vanish from the page.
 * On 2026-09-05 that left the whole EU offer at one machine, because Hetzner
 * had cx33, cx43 and cx53 sold out in all three EU locations at once. A row
 * that disappears reads as a bug; a row that costs more and says why does not.
 *
 * THE RULE. A stand-in matches the sold-out entry's RAM exactly and stays in
 * the SAME location, because a volume never leaves the location it was made
 * in. It comes from the regular line, never from the dedicated one, whose
 * prices are another order again. Equal cpu wins over cheaper, so a stand-in
 * is a like-for-like machine first and a cheap one second.
 *
 * WHAT IT NEVER DOES. It never stands in for an entry that IS in stock, so a
 * location with cx23 on the shelf shows cx23 and no cpx22 beside it. It never
 * adds a type the page already offers in its own right, and it never lets two
 * sold-out entries land on the same stand-in.
 *
 * Prices are compared as plain numbers because one Hetzner account bills in
 * one currency, so every offer here carries the same one.
 */
export function hetznerCatalogWithStandIns(
  available: readonly HetznerOffer[],
  specs: ReadonlyMap<string, HetznerTypeSpec>,
  allowlist: ReadonlySet<string>,
): ProviderMachineType[] {
  const inStock = available.filter((offer) => allowlist.has(offer.machineType.id));
  const taken = new Set(inStock.map((offer) => offer.machineType.id));
  const catalog = inStock.map((offer) => offer.machineType);
  for (const entry of allowlist) {
    if (taken.has(entry)) continue;
    const { type, location } = machineId(entry);
    if (location === null) continue;
    const soldOut = specs.get(type);
    if (soldOut === undefined || soldOut.category !== HETZNER_COST_OPTIMIZED) continue;
    const [standIn] = available
      .filter((offer) =>
        offer.category === HETZNER_REGULAR_PURPOSE
        && offer.machineType.location === location
        && offer.machineType.memGb === soldOut.memGb
        && !taken.has(offer.machineType.id))
      .sort((left, right) =>
        Number(right.machineType.cpuCores === soldOut.cpuCores)
          - Number(left.machineType.cpuCores === soldOut.cpuCores)
        || byPrice(left) - byPrice(right)
        || left.machineType.id.localeCompare(right.machineType.id));
    if (standIn === undefined) continue;
    taken.add(standIn.machineType.id);
    catalog.push({ ...standIn.machineType, standsInFor: type });
  }
  return catalog;
}


/* -------------------------------- reading one Hetzner server-type payload */

function records(value: unknown, field: string): Record<string, unknown>[] {
  if (!isRecord(value) || !Array.isArray(value[field])) {
    throw new Error(`invalid Hetzner ${field} response`);
  }
  return value[field].filter(isRecord);
}

function stringField(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (!isString(result)) throw new Error(`invalid Hetzner ${field}`);
  return result;
}

function numberField(value: Record<string, unknown>, field: string): number {
  const result = value[field];
  if (!isNumber(result)) throw new Error(`invalid Hetzner ${field}`);
  return result;
}

function isDeprecated(value: Record<string, unknown>): boolean {
  return value.deprecated === true || isRecord(value.deprecation);
}

export { isDeprecated, numberField, records, stringField };

/* ------------------------------- reading one Hetzner failure body */

/** A Hetzner failure body, parsed at the boundary into a named shape. `code`
 * is the machine-readable reason, which tells a definitive pre-creation
 * refusal apart from anything else. Either field is null when the body does
 * not state it. */
export interface HetznerFailure {
  message: string | null;
  code: string | null;
}

export function hetznerFailure(value: unknown): HetznerFailure {
  const error = isRecord(value) && isRecord(value.error) ? value.error : null;
  if (error === null) return { message: null, code: null };
  const raw = isString(error.message)
    ? error.message.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim()
    : "";
  return {
    message: raw === "" ? null : raw.slice(0, 1_024),
    code: isString(error.code) ? error.code : null,
  };
}

export function annotateServerTypeIds(
  message: string,
  names: ReadonlyMap<number, string>,
): string {
  return message.replace(/\bserver type (\d+)\b/giu, (match, rawId: string) => {
    const name = names.get(Number(rawId));
    return name === undefined ? match : `${match} (${name})`;
  });
}

export function serverTypeIds(message: string): number[] {
  const ids = [...message.matchAll(/\bserver type (\d+)\b/giu)]
    .map((match) => Number(match[1]))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  return [...new Set(ids)].slice(0, 8);
}
