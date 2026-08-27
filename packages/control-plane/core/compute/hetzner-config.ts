/** Hetzner configuration: the Worker vars this provider reads, the warnings it
 * raises about them, and the small pure helpers that parse a machine-type id.
 * Split out of `hetzner.ts` so the adapter itself stays under the 700-line
 * warn. Nothing here performs I/O. */

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
// Default catalog: two cheap EU types first, then the two US-west types.
// Gross price each month, read from /v1/pricing on 2026-08-25: cx23@hel1
// 6.49, cx33@hel1 9.99, cpx21@hil 37.49, cpx31@hil 73.49. That account bills
// in USD. The figures are the same numbers this comment once called euro,
// which is how the wrong sign reached the cards.
// cx33@hel1 gives the same 4 cpu and 8 GB as cpx31@hil. It costs about one
// seventh as much. That is the reason for the EU entries.
// Hetzner does not sell cpx21 or cpx31 in any EU location. It sells the cx
// line only in hel1. A cheaper EU box needs a different type, not the same
// type in a different region.
// Operators override the catalog with the HETZNER_MACHINE_TYPES Worker var.
// The catalog constrains what the create page offers; existing workspaces on
// other types keep working because ownership stays shape-based.
export const DEFAULT_HETZNER_MACHINE_TYPES: readonly string[] = [
  "cx23@hel1",
  "cx33@hel1",
  "cpx21@hil",
  "cpx31@hil",
];

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

