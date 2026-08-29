import { isNumber, isRecord, isString } from "../http.js";
import type { CreateVolumeRequest, MachinePrice, Volume } from "../wire.js";
import { fetchBoundedJson, type Fetcher } from "./json-fetch.js";
import {
  HETZNER_STOCK_IMAGE,
  HETZNER_USER_DATA_MAX_BYTES,
  hetznerMachineTypeAllowlistFromEnv,
  hetznerServerImagesFromEnv,
  machineId,
  SERVER_TYPE_NAME_PATTERN,
  LOCATION_NAME_PATTERN,
  type HetznerWarningSink,
} from "./hetzner-config.js";
import type {
  CreatedVm,
  CreateVmInput,
  ProviderMachineType,
  ProviderCapabilities,
  VmInspection,
  VmProvider,
  VolumeProvider,
} from "./types.js";
import {
  BOX_IMAGE_TICKETS_SINCE_MS,
  BOX_IMAGE_VIEWER_GUARDS_SINCE_MS,
} from "../webapp-tickets.js";

const API = "https://api.hetzner.cloud/v1";
const SHUTDOWN_POLL_INTERVAL_MS = 1_000;
// A detach is an async Hetzner action. These bound the wait for the volume to
// actually come free, which is what the next attach needs.
const DETACH_POLL_INTERVAL_MS = 1_000;
const DETACH_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 45_000;
// Hetzner bills some accounts in euro and some in dollars, and /v1/pricing
// says which. A constant here read "EUR" and printed a euro sign over dollar
// amounts on every card. The account this repo deploys with bills in USD.
const ISO_4217_PATTERN = /^[A-Z]{3}$/u;

export interface HetznerProviderOptions {
  fetcher?: Fetcher;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Raw HETZNER_MACHINE_TYPES Worker var; unset or blank keeps the default catalog. */
  machineTypeCatalog?: string;
  /** Raw HETZNER_SERVER_IMAGES Worker var: the golden-image map. Unset or
   * blank boots stock Ubuntu and pays the full bootstrap. */
  serverImages?: string;
  /** Receives one structured warning per malformed catalog entry, and one
   * more when Hetzner does not state a usable billing currency. */
  warn?: HetznerWarningSink;
}

interface CreateServerBody {
  name: string;
  server_type: string;
  image: string;
  user_data: string;
  labels: {
    "blitz-workspace": string;
    /** The machine this server is an incarnation of. Operators match a server
     * to a row by these two labels; the workspace one alone stopped being
     * unique when a workspace grew a VM per member. */
    "blitz-machine": string;
    "blitz-purpose": "workspace";
  };
  location?: string;
  /** Hetzner attaches these before the guest boots, so the bootstrap's
   * one-shot scan of /dev/disk/by-id always sees the device. Attaching after
   * create raced that scan and left the box with no persistent disk. */
  volumes?: number[];
}

type HetznerRequestHeaders = {
  Authorization: string;
  "Content-Type"?: "application/json";
};

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  abortReason: Error,
): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(abortReason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (cause: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(cause);
      },
    );
  });
}

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

/** Carries Hetzner's machine-readable error code beside the message, so a
 * caller can tell a definitive pre-creation refusal from anything else.
 * Existing catchers read `.message` only and are unaffected. */
export class HetznerApiError extends Error {
  constructor(message: string, readonly code: string | null) {
    super(message);
    this.name = "HetznerApiError";
  }
}

/** A Hetzner failure body, parsed at the boundary into a named shape. `code`
 * is the machine-readable reason, which tells a definitive pre-creation
 * refusal apart from anything else. Either field is null when the body does
 * not state it. */
interface HetznerFailure {
  message: string | null;
  code: string | null;
}

function hetznerFailure(value: unknown): HetznerFailure {
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

function annotateServerTypeIds(
  message: string,
  names: ReadonlyMap<number, string>,
): string {
  return message.replace(/\bserver type (\d+)\b/giu, (match, rawId: string) => {
    const name = names.get(Number(rawId));
    return name === undefined ? match : `${match} (${name})`;
  });
}

function serverTypeIds(message: string): number[] {
  const ids = [...message.matchAll(/\bserver type (\d+)\b/giu)]
    .map((match) => Number(match[1]))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  return [...new Set(ids)].slice(0, 8);
}

function volumeFromHetzner(value: Record<string, unknown>): Volume {
  const server = value.server;
  return {
    id: String(numberField(value, "id")),
    name: stringField(value, "name"),
    sizeGb: numberField(value, "size"),
    location: isRecord(value.location) ? stringField(value.location, "name") : "",
    status: isNumber(server) ? "attached" : "available",
    attachedTo: isNumber(server) ? String(server) : null,
  };
}

export {
  DEFAULT_HETZNER_MACHINE_TYPES,
  HETZNER_STOCK_IMAGE,
  HETZNER_USER_DATA_MAX_BYTES,
  hetznerMachineTypeAllowlistFromEnv,
  hetznerServerImagesFromEnv,
} from "./hetzner-config.js";
export type {
  HetznerMachineTypeCatalogWarning,
  HetznerPriceCurrencyWarning,
  HetznerProviderWarning,
  HetznerServerImageWarning,
  HetznerWarningSink,
} from "./hetzner-config.js";

export class HetznerProvider implements VmProvider, VolumeProvider {
  readonly id = "hetzner";
  private readonly serverTypeNames = new Map<number, string>();
  private readonly fetcher: Fetcher;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly machineTypeAllowlist: ReadonlySet<string>;
  private readonly serverImages: ReadonlyMap<string, string>;
  private readonly warn: HetznerWarningSink;

  constructor(
    private readonly token: string,
    options: HetznerProviderOptions = {},
  ) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? sleep;
    this.warn = options.warn ?? (() => {});
    this.machineTypeAllowlist = hetznerMachineTypeAllowlistFromEnv(
      options.machineTypeCatalog,
      this.warn,
    );
    this.serverImages = hetznerServerImagesFromEnv(options.serverImages, this.warn);
  }

  /** The image this location boots. A golden snapshot carries docker and the
   * box image already, which removes about 94 seconds of first-boot work
   * (measured 2026-08-27: 18.3 s apt update, 17.4 s docker install, 58 s box
   * image download and load). Stock Ubuntu is the answer when no snapshot is
   * configured for the location. */
  private serverImage(location: string | null): string {
    const exact = location === null ? undefined : this.serverImages.get(location);
    return exact ?? this.serverImages.get("*") ?? HETZNER_STOCK_IMAGE;
  }

  capabilities(): ProviderCapabilities {
    return {
      volumes: true,
      attachesVolumesAtCreate: true,
      maxUserDataBytes: HETZNER_USER_DATA_MAX_BYTES,
      webAppTicketsSinceMs: BOX_IMAGE_TICKETS_SINCE_MS,
      webAppViewerGuardsSinceMs: BOX_IMAGE_VIEWER_GUARDS_SINCE_MS,
    };
  }

  ownsMachineType(machineTypeId: string): boolean {
    const selected = machineId(machineTypeId);
    return SERVER_TYPE_NAME_PATTERN.test(selected.type)
      && (selected.location === null || LOCATION_NAME_PATTERN.test(selected.location));
  }

  ownsVmId(vmId: string): boolean {
    return /^\d+$/u.test(vmId);
  }

  /** Hetzner requires a volume and its server in one location, and the machine
   * type states it after the last `@`. A type with no location (the account
   * default) cannot place a volume, so it gets none. */
  volumeLocation(machineTypeId: string): string | null {
    const selected = machineId(machineTypeId);
    if (selected.location === null) return null;
    return LOCATION_NAME_PATTERN.test(selected.location) ? selected.location : null;
  }

  private async request(
    path: string,
    init?: RequestInit,
    notFoundIsNull = false,
  ): Promise<unknown> {
    const headers: HetznerRequestHeaders = {
      Authorization: `Bearer ${this.token}`,
    };
    if (init?.body !== undefined) headers["Content-Type"] = "application/json";
    const { response, body } = await fetchBoundedJson(this.fetcher, `${API}${path}`, {
      ...init,
      headers,
    }, {
      responseLabel: "Hetzner",
      bodyDisposition: (candidate) =>
        candidate.status === 204 || (candidate.status === 404 && notFoundIsNull)
          ? "omit"
          : "read",
      invalidJsonDisposition: (candidate) => candidate.ok ? "native-error" : "null",
    });
    if (response.status === 404 && notFoundIsNull) return null;
    if (!response.ok) {
      const failure = hetznerFailure(body);
      const message = failure.message;
      if (message === null) {
        throw new Error(`Hetzner API request failed with status ${response.status}`);
      }
      await this.resolveServerTypeNames(message);
      throw new HetznerApiError(
        annotateServerTypeIds(message, this.serverTypeNames),
        failure.code,
      );
    }
    if (response.status === 204) return null;
    return body;
  }

  private async resolveServerTypeNames(message: string): Promise<void> {
    await Promise.all(
      serverTypeIds(message).map(async (id) => {
        if (this.serverTypeNames.has(id)) return;
        try {
          const { response, body } = await fetchBoundedJson(
            this.fetcher,
            `${API}/server_types/${id}`,
            { headers: { Authorization: `Bearer ${this.token}` } },
            {
              responseLabel: "Hetzner server type",
              bodyDisposition: () => "read",
              invalidJsonDisposition: () => "null",
            },
          );
          if (!response.ok) return;
          const value = body;
          if (!isRecord(value) || !isRecord(value.server_type)) return;
          const responseId = value.server_type.id;
          const name = value.server_type.name;
          if (
            responseId === id &&
            isString(name) &&
            /^[a-z0-9-]{1,128}$/iu.test(name)
          ) {
            this.serverTypeNames.set(id, name);
          }
        } catch {
          // Preserve the original provider error if the best-effort lookup fails.
        }
      }),
    );
  }

  private async list(
    path: string,
    field: string,
    perPage = 50,
  ): Promise<Record<string, unknown>[]> {
    const result: Record<string, unknown>[] = [];
    let page = 1;
    while (true) {
      const value = await this.request(`${path}?per_page=${perPage}&page=${page}`);
      result.push(...records(value, field));
      const nextPage =
        isRecord(value) &&
        isRecord(value.meta) &&
        isRecord(value.meta.pagination) &&
        isNumber(value.meta.pagination.next_page)
          ? value.meta.pagination.next_page
          : null;
      if (nextPage === null) return result;
      page = nextPage;
    }
  }

  /**
   * The ISO 4217 code Hetzner bills this account in, or null when Hetzner
   * does not state a usable one.
   *
   * This costs one extra request. /server_types carries the prices but names
   * no currency, and /v1/pricing is the only endpoint that names it. The
   * request runs beside the catalog pages, so it adds no waiting time.
   *
   * A failure here leaves the price out; it never empties the catalog. The
   * response is 41.9 KiB against a 64 KiB cap (measured 2026-08-25) and it
   * grows as Hetzner adds server types, so one day it may not fit. Losing
   * every machine because we cannot name a currency is worse than losing a
   * price label.
   */
  private async billingCurrency(): Promise<string | null> {
    let value: unknown;
    try {
      value = await this.request("/pricing");
    } catch (error) {
      this.warn({
        event: "hetzner_price_currency_unavailable",
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    const currency = isRecord(value) && isRecord(value.pricing)
      ? value.pricing.currency
      : undefined;
    if (isString(currency) && ISO_4217_PATTERN.test(currency)) return currency;
    this.warn({
      event: "hetzner_price_currency_unavailable",
      reason: 'expected pricing.currency to be an ISO 4217 code (for example "EUR")',
    });
    return null;
  }

  async listMachineTypes(): Promise<ProviderMachineType[]> {
    // Server-type entries carry per-location price tables, so a 50-item page
    // can exceed the bounded JSON fetch cap; smaller pages keep each response
    // under it.
    // The currency request runs beside the pages, not after them.
    const [types, currency] = await Promise.all([
      this.list("/server_types", "server_types", 10),
      this.billingCurrency(),
    ]);
    for (const type of types) {
      const id = type.id;
      const name = type.name;
      if (isNumber(id) && Number.isSafeInteger(id) && isString(name)) {
        this.serverTypeNames.set(id, name);
      }
    }
    return types.flatMap((type) => {
      if (isDeprecated(type)) return [];
      const locations = Array.isArray(type.locations)
        ? type.locations
            .filter(isRecord)
            .filter((location) => location.available === true && !isDeprecated(location))
        : [];
      // Hetzner prices each location on its own, in one row per location.
      const prices = Array.isArray(type.prices) ? type.prices.filter(isRecord) : [];
      return locations.map((location) => {
        const name = stringField(type, "name");
        const architecture = type.architecture;
        const locationName = stringField(location, "name");
        // Gross is what the customer pays. Hetzner sends it as a decimal
        // string, so it becomes a number here and the browser never parses a
        // price. Number(" ") is 0, so a blank string must not sell a machine
        // for nothing. A malformed row leaves the price out, because a wrong
        // number costs the customer more than a blank card corner does.
        // An unnamed currency does the same: an amount with the wrong sign in
        // front of it is the defect this code exists to stop.
        const monthly = prices.find((price) => price.location === locationName)?.price_monthly;
        const gross = isRecord(monthly) && isString(monthly.gross) ? monthly.gross.trim() : "";
        const amount = gross === "" ? Number.NaN : Number(gross);
        const monthlyPrice: MachinePrice | null = currency !== null && Number.isFinite(amount)
          ? { amount, currency }
          : null;
        return {
          id: `${name}@${locationName}`,
          name,
          cpuCores: numberField(type, "cores"),
          memGb: numberField(type, "memory"),
          diskGb: numberField(type, "disk"),
          arch: architecture === "arm" ? "arm64" : "x86",
          location: locationName,
          monthlyPrice,
        } satisfies ProviderMachineType;
      });
    }).filter((machineType) => this.machineTypeAllowlist.has(machineType.id));
  }

  async createVm(input: CreateVmInput): Promise<CreatedVm> {
    const selected = machineId(input.machineTypeId);
    const body: CreateServerBody = {
      name: `blitz-${input.machineId.slice(0, 12)}`,
      server_type: selected.type,
      image: this.serverImage(selected.location),
      user_data: input.userData,
      labels: {
        "blitz-workspace": input.workspaceId,
        "blitz-machine": input.machineId,
        "blitz-purpose": "workspace",
      },
    };
    if (selected.location !== null) body.location = selected.location;
    const volumes = (input.volumeIds ?? []).map((volumeId) => {
      const numeric = Number(volumeId);
      if (!Number.isSafeInteger(numeric) || numeric <= 0) {
        throw new Error(`invalid Hetzner volume ID: ${volumeId}`);
      }
      return numeric;
    });
    // Hetzner mounts nothing on its own: `automount` stays unset because the
    // bootstrap owns /var/lib/blitz and writes its own fstab entry.
    if (volumes.length > 0) body.volumes = volumes;
    return this.createServer(body, selected.location);
  }

  /**
   * Posts the server, and falls back to stock Ubuntu when a configured golden
   * image is refused.
   *
   * The retry runs only for a definitive refusal of the image: Hetzner
   * answered, so no server was allocated, and a second POST cannot duplicate
   * one. An ambiguous failure (a timeout, a network error) is rethrown
   * untouched, because a retry there could leave two servers behind and only
   * one id to destroy.
   *
   * A workspace that boots stock Ubuntu still works. It just pays the full
   * bootstrap again, so the fallback is warned about rather than swallowed.
   */
  private async createServer(
    body: CreateServerBody,
    location: string | null,
  ): Promise<CreatedVm> {
    const configured = body.image;
    try {
      return await this.postServer(body);
    } catch (error) {
      const refusedImage = configured !== HETZNER_STOCK_IMAGE
        && error instanceof HetznerApiError
        && (error.code === "not_found" || error.code === "invalid_input");
      if (!refusedImage) throw error;
      this.warn({
        event: "hetzner_server_image_rejected",
        location: location ?? "*",
        image: configured,
        reason: error.message,
      });
      return this.postServer({ ...body, image: HETZNER_STOCK_IMAGE });
    }
  }

  /** The single place a server-create response is narrowed. Both the golden
   * image attempt and the stock fallback go through it, so a change to the
   * response shape cannot leave one path behind. */
  private async postServer(body: CreateServerBody): Promise<CreatedVm> {
    const value = await this.request("/servers", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!isRecord(value) || !isRecord(value.server)) {
      throw new Error("invalid Hetzner server response");
    }
    const server = value.server;
    const ipv4 =
      isRecord(server.public_net) &&
      isRecord(server.public_net.ipv4) &&
      isString(server.public_net.ipv4.ip)
        ? server.public_net.ipv4.ip
        : null;
    if (ipv4 === null) throw new Error("Hetzner server has no public IPv4 address");
    return { id: String(numberField(server, "id")), host: ipv4, port: 22, user: "blitz" };
  }

  async shutdown(id: string): Promise<void> {
    const encodedId = encodeURIComponent(id);
    const deadline = this.now() + SHUTDOWN_TIMEOUT_MS;
    const deadlineError = new Error("Hetzner graceful shutdown deadline exceeded");
    const controller = new AbortController();
    const deadlineTimer = setTimeout(() => {
      controller.abort(deadlineError);
    }, SHUTDOWN_TIMEOUT_MS);
    const { signal } = controller;

    try {
      const action = await abortable(
        this.request(
          `/servers/${encodedId}/actions/shutdown`,
          { method: "POST", body: "{}", signal },
          true,
        ),
        signal,
        deadlineError,
      );
      if (action === null) return;

      while (this.now() < deadline) {
        const value = await abortable(
          this.request(`/servers/${encodedId}`, { signal }, true),
          signal,
          deadlineError,
        );
        if (value === null) return;
        if (!isRecord(value) || !isRecord(value.server)) {
          throw new Error("invalid Hetzner server response");
        }
        if (stringField(value.server, "status") === "off") return;
        const remaining = deadline - this.now();
        if (remaining > 0) {
          await abortable(
            this.sleep(Math.min(SHUTDOWN_POLL_INTERVAL_MS, remaining)),
            signal,
            deadlineError,
          );
        }
      }
    } catch (error) {
      if (error !== deadlineError) throw error;
    } finally {
      clearTimeout(deadlineTimer);
    }
  }

  async destroy(id: string): Promise<void> {
    await this.request(`/servers/${encodeURIComponent(id)}`, { method: "DELETE" }, true);
  }

  async inspect(id: string): Promise<VmInspection | null> {
    const value = await this.request(`/servers/${encodeURIComponent(id)}`, undefined, true);
    if (value === null) return null;
    if (!isRecord(value) || !isRecord(value.server)) throw new Error("invalid Hetzner server response");
    const server = value.server;
    const ipv4 =
      isRecord(server.public_net) &&
      isRecord(server.public_net.ipv4) &&
      isString(server.public_net.ipv4.ip)
        ? server.public_net.ipv4.ip
        : null;
    if (ipv4 === null) throw new Error("Hetzner server has no public IPv4 address");
    return {
      id: String(numberField(server, "id")),
      host: ipv4,
      port: 22,
      user: "blitz",
      state: server.status === "running" ? "running" : "stopped",
    };
  }

  async createVolume(input: CreateVolumeRequest): Promise<Volume> {
    const value = await this.request("/volumes", {
      method: "POST",
      body: JSON.stringify({
        name: input.name,
        size: input.sizeGb,
        location: input.location,
        format: "ext4",
      }),
    });
    if (!isRecord(value) || !isRecord(value.volume)) throw new Error("invalid Hetzner volume response");
    return volumeFromHetzner(value.volume);
  }

  async attachVolume(volumeId: string, vmId: string): Promise<void> {
    const server = Number(vmId);
    if (!Number.isSafeInteger(server)) throw new Error("invalid Hetzner server ID");
    await this.request(`/volumes/${encodeURIComponent(volumeId)}/actions/attach`, {
      method: "POST",
      body: JSON.stringify({ server, automount: true }),
    });
  }

  /**
   * Detaches the volume and waits for Hetzner to finish.
   *
   * The POST only starts an action. Returning on the POST let a destroy report
   * success while the volume was still attached, and an immediate recreate on
   * that volume then failed with "volume already attached". Measured on a real
   * destroy/recreate pair on 2026-08-27, so the wait is the fix, not a guard
   * against a hypothetical.
   *
   * The postcondition is polled rather than the action id: "no server holds
   * this volume" is what the next attach actually needs. A timeout returns
   * quietly, because the janitor retries and a destroy must not wedge on a
   * volume Hetzner is slow to release.
   */
  async detachVolume(volumeId: string, vmId: string): Promise<void> {
    const path = `/volumes/${encodeURIComponent(volumeId)}`;
    const value = await this.request(path, undefined, true);
    if (value === null) return;
    if (!isRecord(value) || !isRecord(value.volume)) throw new Error("invalid Hetzner volume response");
    if (value.volume.server !== Number(vmId)) return;
    await this.request(`${path}/actions/detach`, { method: "POST", body: "{}" });

    const deadline = this.now() + DETACH_TIMEOUT_MS;
    while (this.now() < deadline) {
      const current = await this.request(path, undefined, true);
      if (current === null) return;
      if (!isRecord(current) || !isRecord(current.volume)) {
        throw new Error("invalid Hetzner volume response");
      }
      if (current.volume.server === null) return;
      await this.sleep(Math.min(DETACH_POLL_INTERVAL_MS, deadline - this.now()));
    }
  }

  async deleteVolume(id: string): Promise<void> {
    await this.request(`/volumes/${encodeURIComponent(id)}`, { method: "DELETE" }, true);
  }

  async listVolumes(): Promise<Volume[]> {
    return (await this.list("/volumes", "volumes")).map(volumeFromHetzner);
  }
}
