import { first, rows, type Db } from "../db.js";
import {
  HttpError,
  isRecord,
  isString,
  type JsonValue,
  readJson,
  requiredString,
} from "../http.js";
import type { Principal } from "../principals.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "../runtime.js";
import { openRoot, sealRoot } from "../connections/root-crypto.js";
import {
  awsProviderForCredentials,
  awsProviderFromEnv,
  type AwsProviderEnv,
  type AwsProviderOptions,
} from "./aws.js";
import { childElement, childText, parseXml, type XmlElement } from "./aws-xml.js";
import { signAwsQueryRequest, type AwsCredentials } from "./aws-sigv4.js";
import {
  HetznerProvider,
  type HetznerProviderOptions,
  type HetznerWarningSink,
} from "./hetzner.js";
import {
  fetchBoundedJson,
  fetchBoundedText,
  type Fetcher,
  type JsonValue as ResponseJsonValue,
} from "./json-fetch.js";
import type {
  ComputeCredentialSource,
  VmProvider,
  VolumeProvider,
} from "./types.js";

const HETZNER_API = "https://api.hetzner.cloud/v1";
const AWS_STS_VERSION = "2011-06-15";

export const COMPUTE_CREDENTIAL_PROVIDERS = ["hetzner", "aws"] as const;
export type ComputeCredentialProvider = (typeof COMPUTE_CREDENTIAL_PROVIDERS)[number];
export type { ComputeCredentialSource } from "./types.js";

interface HetznerCredential {
  readonly provider: "hetzner";
  readonly token: string;
}

interface AwsCredential extends AwsCredentials {
  readonly provider: "aws";
}

type ComputeCredential = HetznerCredential | AwsCredential;
type CloudComputeProvider = VmProvider & VolumeProvider;

interface ComputeCredentialRow {
  org_id: string;
  provider: ComputeCredentialProvider;
  ciphertext: string;
  created_by_membership_id: string;
  created_at: number;
  validated_at: number;
}

interface ComputeCredentialMetadataRow {
  provider: ComputeCredentialProvider;
  created_by_membership_id: string;
  validated_at: number;
}

export interface ComputeCredentialMetadata {
  provider: ComputeCredentialProvider;
  validated_at: number;
  created_by: string;
}

export interface ResolvedComputeProvider {
  readonly provider: CloudComputeProvider;
  readonly credentialSource: ComputeCredentialSource;
}

export interface ComputeProviderStatus {
  readonly providerId: ComputeCredentialProvider;
  readonly access: ComputeCredentialSource | "credential-required";
}

export interface ComputeProviderEnvironment extends AwsProviderEnv {
  HETZNER_API_TOKEN?: string;
  HETZNER_MACHINE_TYPES?: string;
}

export interface OrgComputeProviderResolverOptions {
  fetcher?: Fetcher;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  warn?: HetznerWarningSink;
}

function computeCredentialProvider(value: string): ComputeCredentialProvider {
  if (value === "hetzner" || value === "aws") return value;
  throw new HttpError(400, "provider must be hetzner or aws");
}

function optionalCredentialString(value: JsonValue | undefined, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredString(value, field);
}

function credentialRequest(
  provider: ComputeCredentialProvider,
  value: JsonValue,
): ComputeCredential {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  if (provider === "hetzner") {
    return { provider, token: requiredString(value.token, "token") };
  }
  const accessKeyId = requiredString(value.accessKeyId, "accessKeyId");
  const secretAccessKey = requiredString(value.secretAccessKey, "secretAccessKey");
  const sessionToken = optionalCredentialString(value.sessionToken, "sessionToken");
  return sessionToken === undefined
    ? { provider, accessKeyId, secretAccessKey }
    : { provider, accessKeyId, secretAccessKey, sessionToken };
}

function storedCredential(
  provider: ComputeCredentialProvider,
  plaintext: string,
): ComputeCredential {
  let value: JsonValue;
  try {
    value = JSON.parse(plaintext);
  } catch {
    throw new Error(`stored ${provider} credential is invalid`);
  }
  try {
    return credentialRequest(provider, value);
  } catch {
    throw new Error(`stored ${provider} credential is invalid`);
  }
}

function credentialOwnerName(orgId: string, provider: ComputeCredentialProvider): string {
  return `org-compute:${orgId}:${provider}`;
}

function metadata(row: ComputeCredentialMetadataRow): ComputeCredentialMetadata {
  return {
    provider: row.provider,
    validated_at: row.validated_at,
    created_by: row.created_by_membership_id,
  };
}

function sanitizeProviderMessage(message: string): string {
  return message.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim().slice(0, 1_024);
}

function hetznerErrorMessage(value: ResponseJsonValue | null): string | null {
  if (!isRecord(value) || !isRecord(value.error) || !isString(value.error.message)) return null;
  const message = sanitizeProviderMessage(value.error.message);
  return message === "" ? null : message;
}

function parseHetznerValidationResponse(value: ResponseJsonValue | null): void {
  if (!isRecord(value) || !Array.isArray(value.servers)) {
    throw new Error("invalid Hetzner servers response");
  }
}

async function validateHetznerCredential(
  credential: HetznerCredential,
  fetcher: Fetcher,
): Promise<void> {
  const { response, body } = await fetchBoundedJson(
    fetcher,
    `${HETZNER_API}/servers?per_page=1`,
    { headers: { Authorization: `Bearer ${credential.token}` } },
    {
      responseLabel: "Hetzner credential validation",
      bodyDisposition: () => "read",
      invalidJsonDisposition: (candidate) => candidate.ok ? "provider-error" : "null",
    },
  );
  if (!response.ok) {
    const message = hetznerErrorMessage(body);
    throw new Error(message ?? `Hetzner credential validation failed with status ${response.status}`);
  }
  parseHetznerValidationResponse(body);
}

function awsErrorElement(document: XmlElement): XmlElement | null {
  const errors = childElement(document, "Errors");
  return errors === null ? childElement(document, "Error") : childElement(errors, "Error");
}

function parseAwsValidationResponse(document: XmlElement): void {
  const result = childElement(document, "GetCallerIdentityResult");
  if (
    result === null
    || childText(result, "Account") === null
    || childText(result, "Arn") === null
    || childText(result, "UserId") === null
  ) {
    throw new Error("invalid AWS STS GetCallerIdentity response");
  }
}

async function validateAwsCredential(
  credential: AwsCredential,
  region: string,
  fetcher: Fetcher,
  now: () => number,
): Promise<void> {
  if (region === "") throw new Error("AWS_REGION must be configured for AWS compute");
  const host = `sts.${region}.amazonaws.com`;
  const signed = await signAwsQueryRequest({
    credentials: credential,
    region,
    service: "sts",
    host,
    parameters: [["Action", "GetCallerIdentity"], ["Version", AWS_STS_VERSION]],
    signedAt: new Date(now()),
  });
  const { response, body } = await fetchBoundedText(
    fetcher,
    signed.url,
    { method: "POST", headers: signed.headers, body: signed.body },
    { responseLabel: "AWS STS GetCallerIdentity", bodyDisposition: () => "read" },
  );
  const document = parseXml(body ?? "");
  if (!response.ok) {
    const error = awsErrorElement(document);
    const message = error === null ? null : childText(error, "Message");
    const sanitized = message === null ? "" : sanitizeProviderMessage(message);
    throw new Error(
      sanitized === ""
        ? `AWS STS GetCallerIdentity failed with status ${response.status}`
        : sanitized,
    );
  }
  parseAwsValidationResponse(document);
}

function hetznerOptions(options: OrgComputeProviderResolverOptions): HetznerProviderOptions {
  const result: HetznerProviderOptions = {};
  if (options.fetcher !== undefined) result.fetcher = options.fetcher;
  if (options.now !== undefined) result.now = options.now;
  if (options.sleep !== undefined) result.sleep = options.sleep;
  if (options.warn !== undefined) result.warn = options.warn;
  return result;
}

function awsOptions(options: OrgComputeProviderResolverOptions): AwsProviderOptions {
  const result: AwsProviderOptions = {};
  if (options.fetcher !== undefined) result.fetcher = options.fetcher;
  if (options.now !== undefined) result.now = options.now;
  if (options.sleep !== undefined) result.sleep = options.sleep;
  return result;
}

/** Per-runtime resolver. It decrypts an org credential only at the provider
 * action that needs it and constructs a fresh adapter around that identity.
 * A source pinned as `org` is strict: deletion never exposes a destructive
 * call to the deployment credential. */
export class OrgComputeProviderResolver {
  private readonly fetcher: Fetcher;
  private readonly now: () => number;
  private readonly hetznerProviderOptions: HetznerProviderOptions;
  private readonly awsProviderOptions: AwsProviderOptions;
  private readonly deploymentProviders = new Map<ComputeCredentialProvider, CloudComputeProvider>();
  private readonly providerDescriptors: readonly VmProvider[];

  constructor(
    private readonly db: Db,
    private readonly credentialMasterKey: CryptoKey,
    private readonly env: ComputeProviderEnvironment,
    options: OrgComputeProviderResolverOptions = {},
  ) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.hetznerProviderOptions = hetznerOptions(options);
    if (env.HETZNER_MACHINE_TYPES !== undefined) {
      this.hetznerProviderOptions.machineTypeCatalog = env.HETZNER_MACHINE_TYPES;
    }
    this.awsProviderOptions = awsOptions(options);

    const deploymentHetznerToken = env.HETZNER_API_TOKEN ?? "";
    const deploymentHetzner = new HetznerProvider(
      deploymentHetznerToken,
      this.hetznerProviderOptions,
    );
    if (deploymentHetznerToken !== "") {
      this.deploymentProviders.set("hetzner", deploymentHetzner);
    }

    const deploymentAws = awsProviderFromEnv(env, this.awsProviderOptions);
    if (deploymentAws !== undefined) this.deploymentProviders.set("aws", deploymentAws);
    const awsDescriptor = deploymentAws ?? this.awsDescriptor();
    this.providerDescriptors = awsDescriptor === undefined
      ? [deploymentHetzner]
      : [deploymentHetzner, awsDescriptor];
  }

  descriptors(): readonly VmProvider[] {
    return this.providerDescriptors;
  }

  handles(providerId: string): providerId is ComputeCredentialProvider {
    return providerId === "hetzner" || providerId === "aws";
  }

  private awsDescriptor(): VmProvider | undefined {
    if ((this.env.AWS_REGION ?? "") === "") return undefined;
    return awsProviderForCredentials(
      this.env,
      { accessKeyId: "descriptor", secretAccessKey: "descriptor" },
      this.awsProviderOptions,
    );
  }

  private providerForCredential(credential: ComputeCredential): CloudComputeProvider {
    if (credential.provider === "hetzner") {
      return new HetznerProvider(credential.token, this.hetznerProviderOptions);
    }
    return awsProviderForCredentials(this.env, credential, this.awsProviderOptions);
  }

  private async orgCredential(
    orgId: string,
    provider: ComputeCredentialProvider,
  ): Promise<ComputeCredential | null> {
    const row = await first<ComputeCredentialRow>(this.db, {
      q: `SELECT org_id, provider, ciphertext, created_by_membership_id,
                 created_at, validated_at
          FROM org_compute_credentials
          WHERE org_id = ?1 AND provider = ?2 LIMIT 1`,
      v: [orgId, provider],
    });
    if (row === null) return null;
    const plaintext = await openRoot(
      this.credentialMasterKey,
      credentialOwnerName(orgId, provider),
      row.ciphertext,
    );
    return storedCredential(provider, plaintext);
  }

  /** An org containing an active platform operator belongs to the deployment
   * owner, so it may use deployment credentials. Every other org is a tenant
   * and must bring its own key for new cloud workspaces. This is org-scoped:
   * a hosted operator keeps their own deployment usable without extending
   * that billing identity to tenant orgs. */
  private async orgMayUseDeploymentCredential(orgId: string): Promise<boolean> {
    return await first<{ allowed: number }>(this.db, {
      q: `SELECT 1 AS allowed
          FROM memberships membership
          JOIN users user ON user.id = membership.user_id
          WHERE membership.org_id = ?1
            AND membership.status = 'active'
            AND user.platform_operator = 1
          LIMIT 1`,
      v: [orgId],
    }) !== null;
  }

  private deployment(
    provider: ComputeCredentialProvider,
  ): ResolvedComputeProvider {
    const deployment = this.deploymentProviders.get(provider);
    if (deployment !== undefined) {
      return { provider: deployment, credentialSource: "deployment" };
    }
    throw new HttpError(409, `org has no ${provider} credential`);
  }

  private credentialRequired(
    provider: ComputeCredentialProvider,
    orgId: string,
  ): HttpError {
    const route = `/orgs/${encodeURIComponent(orgId)}/compute-credentials/${provider}`;
    return new HttpError(
      402,
      `${provider} compute credential required; an organization admin can add one at ${route}`,
    );
  }

  async providerStatuses(orgId: string): Promise<ComputeProviderStatus[]> {
    const configured = new Set((await rows<{ provider: ComputeCredentialProvider }>(this.db, {
      q: `SELECT provider FROM org_compute_credentials
          WHERE org_id = ?1 ORDER BY provider`,
      v: [orgId],
    })).map(({ provider }) => provider));
    const deploymentAllowed = await this.orgMayUseDeploymentCredential(orgId);
    return this.providerDescriptors.flatMap(({ id }) => {
      if (!this.handles(id)) return [];
      const access: ComputeProviderStatus["access"] = configured.has(id)
        ? "org"
        : deploymentAllowed && this.deploymentProviders.has(id)
          ? "deployment"
          : "credential-required";
      return [{ providerId: id, access }];
    });
  }

  async resolve(
    provider: ComputeCredentialProvider,
    orgId: string,
    requiredSource?: ComputeCredentialSource | null,
  ): Promise<ResolvedComputeProvider> {
    if (requiredSource !== "deployment") {
      const credential = await this.orgCredential(orgId, provider);
      if (credential !== null) {
        return { provider: this.providerForCredential(credential), credentialSource: "org" };
      }
      if (requiredSource === "org") {
        throw new HttpError(409, `org has no ${provider} credential`);
      }
    }
    if (
      requiredSource !== "deployment"
      && !(await this.orgMayUseDeploymentCredential(orgId))
    ) {
      throw this.credentialRequired(provider, orgId);
    }
    return this.deployment(provider);
  }

  async resolveVolume(
    orgId: string,
    requiredSource?: ComputeCredentialSource | null,
  ): Promise<ResolvedComputeProvider> {
    if (requiredSource === "deployment") return this.deployment("hetzner");
    const credential = await this.orgCredential(orgId, "hetzner");
    if (credential !== null) {
      return { provider: this.providerForCredential(credential), credentialSource: "org" };
    }
    if (requiredSource === "org") {
      throw new HttpError(409, "org has no hetzner credential");
    }
    // Volume creation keeps the pre-BYOK fallback. The tenant gate is scoped
    // to new cloud workspaces; lifecycle calls arrive with their pinned source.
    return this.deployment("hetzner");
  }

  async validate(credential: ComputeCredential): Promise<void> {
    try {
      if (credential.provider === "hetzner") {
        await validateHetznerCredential(credential, this.fetcher);
      } else {
        await validateAwsCredential(
          credential,
          this.env.AWS_REGION ?? "",
          this.fetcher,
          this.now,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "credential validation failed";
      throw new HttpError(400, message);
    }
  }
}

interface OrgComputeActor {
  orgId: string;
  membershipId: string;
}

function requireOrgAdmin(principal: Principal, requestedOrgId: string): OrgComputeActor {
  if (
    principal.orgId === null
    || principal.membershipId === null
    || principal.role !== "admin"
    || principal.orgId !== requestedOrgId
  ) {
    throw new HttpError(403, "organization admin required");
  }
  return { orgId: principal.orgId, membershipId: principal.membershipId };
}

export function addOrgComputeCredentialRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  router.put("/orgs/:id/compute-credentials/:provider", async (context) => {
    const principal = await requirePrincipal(context);
    const actor = requireOrgAdmin(principal, context.req.param("id"));
    const provider = computeCredentialProvider(context.req.param("provider"));
    const credential = credentialRequest(provider, await readJson(context.req.raw));
    const runtime = runtimeFactory(context);
    await runtime.providers.compute.validate(credential);
    const now = Date.now();
    const ciphertext = await sealRoot(
      runtime.credentialMasterKey,
      credentialOwnerName(actor.orgId, provider),
      JSON.stringify(credential),
    );
    await rows(runtime.db, {
      q: `INSERT INTO org_compute_credentials
          (org_id, provider, ciphertext, created_by_membership_id, created_at, validated_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?5)
          ON CONFLICT(org_id, provider) DO UPDATE SET
            ciphertext = excluded.ciphertext,
            created_by_membership_id = excluded.created_by_membership_id,
            created_at = excluded.created_at,
            validated_at = excluded.validated_at`,
      v: [actor.orgId, provider, ciphertext, actor.membershipId, now],
    });
    return context.json<ComputeCredentialMetadata>({
      provider,
      validated_at: now,
      created_by: actor.membershipId,
    });
  });

  router.get("/orgs/:id/compute-credentials/:provider", async (context) => {
    const principal = await requirePrincipal(context);
    const actor = requireOrgAdmin(principal, context.req.param("id"));
    const provider = computeCredentialProvider(context.req.param("provider"));
    const row = await first<ComputeCredentialMetadataRow>(runtimeFactory(context).db, {
      q: `SELECT provider, created_by_membership_id, validated_at
          FROM org_compute_credentials
          WHERE org_id = ?1 AND provider = ?2 LIMIT 1`,
      v: [actor.orgId, provider],
    });
    if (row === null) throw new HttpError(404, "compute credential not found");
    return context.json<ComputeCredentialMetadata>(metadata(row));
  });

  router.delete("/orgs/:id/compute-credentials/:provider", async (context) => {
    const principal = await requirePrincipal(context);
    const actor = requireOrgAdmin(principal, context.req.param("id"));
    const provider = computeCredentialProvider(context.req.param("provider"));
    const existing = await first<{ provider: string }>(runtimeFactory(context).db, {
      q: `DELETE FROM org_compute_credentials
          WHERE org_id = ?1 AND provider = ?2 RETURNING provider`,
      v: [actor.orgId, provider],
    });
    if (existing === null) throw new HttpError(404, "compute credential not found");
    return context.body(null, 204);
  });
}
