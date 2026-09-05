import type { CreateVolumeRequest, Volume } from "../wire.js";
import {
  BOX_IMAGE_SHARED_SESSIONS_SINCE_MS,
  BOX_IMAGE_TICKETS_SINCE_MS,
  BOX_IMAGE_VIEWER_GUARDS_SINCE_MS,
} from "../webapp-tickets.js";
import { fetchBoundedText, type Fetcher } from "./json-fetch.js";
import {
  signAwsQueryRequest,
  type AwsCredentials,
  type AwsQueryParameters,
} from "./aws-sigv4.js";
import { childElement, childText, parseXml, setItems, type XmlElement } from "./aws-xml.js";
import { awsMonthlyPrice } from "./aws-prices.js";
import type {
  CreatedVm,
  CreateVmInput,
  ProviderCapabilities,
  ProviderMachineType,
  VmInspection,
  VmProvider,
  VolumeProvider,
} from "./types.js";

const EC2_API_VERSION = "2016-11-15";
const EC2_SERVICE = "ec2";

/** EC2 caps instance user data at 16 KiB "in raw form, before it is
 * base64-encoded" (EC2 User Guide, "Run commands when you launch an EC2
 * instance with user data input"). The bootstrap outgrew that cap once, so
 * this adapter gzips user data before sending it — cloud-init detects the
 * gzip magic and decompresses transparently — and enforces the EC2 cap on
 * the COMPRESSED payload. */
export const AWS_USER_DATA_MAX_BYTES = 16 * 1024;

/** What the adapter advertises upstream as its raw user-data budget. Shell
 * text compresses well past 3:1, so 48 KiB raw stays comfortably inside the
 * 16 KiB compressed wire cap; the compressed-size check below is the hard
 * backstop if it ever does not. */
export const AWS_USER_DATA_RAW_MAX_BYTES = 48 * 1024;

/** Machine type ids are `aws-<ec2InstanceType>@<region>`, for example
 * `aws-t3.medium@us-east-1`. The `aws-` prefix cannot collide with Hetzner
 * (`^[a-z]+\d+$` before the `@`) ids. */
const MACHINE_TYPE_PATTERN =
  /^aws-([a-z][a-z0-9]*\.[a-z0-9]+)@([a-z]{2}(?:-[a-z]+)+-\d+)$/u;
const REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-\d+$/u;
/** VM ids are the raw EC2 instance id: `i-` plus 8 or 17 lowercase hex digits. */
const VM_ID_PATTERN = /^i-[0-9a-f]{8}(?:[0-9a-f]{9})?$/u;
const VOLUME_ID_PATTERN = /^vol-[0-9a-f]{8}(?:[0-9a-f]{9})?$/u;
const SECURITY_GROUP_ID_PATTERN = /^sg-[0-9a-f]{8}(?:[0-9a-f]{9})?$/u;
const SUBNET_ID_PATTERN = /^subnet-[0-9a-f]{8}(?:[0-9a-f]{9})?$/u;
const IMAGE_ID_PATTERN = /^ami-[0-9a-f]{8}(?:[0-9a-f]{9})?$/u;

const CANONICAL_OWNER_ID = "099720109477";
const UBUNTU_IMAGE_NAME =
  "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*";
const ROOT_DEVICE_NAME = "/dev/sda1";
const ATTACH_DEVICE_NAME = "/dev/sdf";
const DEFAULT_ROOT_DISK_GB = 40;
const WORKSPACE_TAG = "blitz-workspace";
const PURPOSE_TAG = "blitz-purpose";
const PURPOSE_VALUE = "workspace";

const POLL_INTERVAL_MS = 1_000;
const POLL_TIMEOUT_MS = 45_000;

const INSTANCE_GONE_CODES = ["InvalidInstanceID.NotFound", "InvalidInstanceId.NotFound"];
const VOLUME_GONE_CODES = ["InvalidVolume.NotFound", "InvalidVolumeID.NotFound"];

interface AwsMachineType {
  readonly instanceType: string;
  readonly cpuCores: number;
  readonly memGb: number;
  readonly diskGb: number;
}

/** Curated, hardcoded catalog. Specs verified with `ec2
 * DescribeInstanceTypes` in us-east-1 on 2026-08-18. `diskGb` is the gp3 root
 * volume this provider requests. Prices live in `aws-prices.ts`, so the specs
 * and the money are not copied into each other.
 *
 * x86_64 only, deliberately: the box image published in `wrangler.toml` is an
 * amd64 tag, so an arm64 instance type would boot and then fail to pull it. */
const MACHINE_TYPES: readonly AwsMachineType[] = [
  { instanceType: "t3.medium", cpuCores: 2, memGb: 4, diskGb: 40 },
  { instanceType: "t3.large", cpuCores: 2, memGb: 8, diskGb: 60 },
  { instanceType: "m6i.large", cpuCores: 2, memGb: 8, diskGb: 60 },
  { instanceType: "m6i.xlarge", cpuCores: 4, memGb: 16, diskGb: 80 },
];

/** The bootstrap lines only an AWS box needs.
 *
 * Canonical gives each EC2 region a mirror at <region>.ec2.archive.ubuntu.com.
 * A dead one accepts the TCP connection and then never answers, and apt-get
 * update still exits 0. So the exit code cannot find the fault. The probe
 * tests the mirror itself and rewrites the sources before the first update.
 * Without it the package lists stay incomplete, and the docker.io install
 * fails later for a reason that looks unrelated.
 *
 * These lines sat in the shared bootstrap until 2026-08-25. There the grep
 * found nothing on a Hetzner box, exited 1, and `set -e` killed the boot at
 * that line. Every non-AWS box failed to create. See
 * plans/PROVIDER-BOOTSTRAP.md. */
const BOOTSTRAP_APT_SETUP = String.raw`# grep exits 1 when it finds no EC2 mirror. That is an ordinary state, not a
# failure, so the condition reads the status. A bare assignment here killed
# every box that has no EC2 mirror.
if ec2_mirror=$(grep -rhoE 'https?://[a-z0-9-]+\.ec2\.archive\.ubuntu\.com' \
  /etc/apt/sources.list /etc/apt/sources.list.d/ 2>/dev/null | head -1) &&
  ! curl -fsS -m 10 -o /dev/null "$ec2_mirror/ubuntu/dists/noble/InRelease"; then
  echo "blitz: $ec2_mirror is unreachable; falling back to archive.ubuntu.com"
  sed -i -E 's|https?://[a-z0-9-]+\.ec2\.archive\.ubuntu\.com|http://archive.ubuntu.com|g' \
    /etc/apt/sources.list /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list 2>/dev/null || true
fi
# The probe catches a dead mirror. A live one can still trickle, so leave it
# behind between apt attempts.
apt_mirror_fallback() {
  sed -i -E 's|https?://[a-z0-9-]+\.ec2\.archive\.ubuntu\.com|http://archive.ubuntu.com|g' \
    /etc/apt/sources.list /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list 2>/dev/null || true
}
`;

export interface AwsProviderConfig {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Only for temporary (STS) credentials; long-lived IAM users omit it. */
  readonly sessionToken?: string;
  readonly region: string;
  /** Pins the AMI. Unset resolves the newest Canonical Ubuntu 24.04 amd64
   * image once per isolate. */
  readonly imageId?: string;
  /** Pins the subnet, and with it the availability zone an EBS volume must
   * share to be attachable. Unset lets EC2 pick a default-VPC subnet. */
  readonly subnetId?: string;
  /** Must admit inbound TCP 22; unset falls back to the VPC default group,
   * which does not. */
  readonly securityGroupIds?: readonly string[];
}

export interface AwsProviderOptions {
  fetcher?: Fetcher;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface AwsProviderEnv {
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_SESSION_TOKEN?: string;
  AWS_REGION?: string;
  AWS_IMAGE_ID?: string;
  AWS_SUBNET_ID?: string;
  AWS_SECURITY_GROUP_IDS?: string;
}

interface MachineSelection {
  readonly instanceType: string;
  readonly region: string;
}

/** Assembled field by field so an absent value is simply never assigned;
 * `anti-slop/no-conditional-empty-object-spread` forbids the `...(x ? {} : …)`
 * trick that would otherwise express this inline. */
interface AwsProviderSettings {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  imageId?: string;
  subnetId?: string;
  securityGroupIds: string[];
}

interface AwsCredentialSettings {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

interface InstanceView {
  readonly id: string;
  readonly publicIp: string;
  readonly state: string;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function base64Utf8(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64Bytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function gzipUtf8(value: string): Promise<Uint8Array> {
  const compressed = new Blob([value]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(compressed).arrayBuffer());
  // Zero the gzip header's MTIME field so the payload — and the SigV4
  // signature over it — is a pure function of the script.
  bytes[4] = 0;
  bytes[5] = 0;
  bytes[6] = 0;
  bytes[7] = 0;
  return bytes;
}

function sanitize(message: string): string {
  return message.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim().slice(0, 1_024);
}

function parseMachineTypeId(machineTypeId: string): MachineSelection | null {
  const match = MACHINE_TYPE_PATTERN.exec(machineTypeId);
  const instanceType = match?.[1];
  const region = match?.[2];
  if (instanceType === undefined || region === undefined) return null;
  return { instanceType, region };
}

function requiredField(element: XmlElement, name: string, label: string): string {
  const value = childText(element, name);
  if (value === null || value === "") throw new Error(`invalid AWS ${label} response`);
  return value;
}

function requiredInteger(element: XmlElement, name: string, label: string): number {
  const value = Number(requiredField(element, name, label));
  if (!Number.isSafeInteger(value)) throw new Error(`invalid AWS ${label} response`);
  return value;
}

/** `<Response><Errors><Error><Code>…` is the query protocol's fault shape;
 * a handful of actions answer with `<ErrorResponse>` instead. */
function errorCode(document: XmlElement): string | null {
  const errors = childElement(document, "Errors");
  const error = errors === null ? childElement(document, "Error") : childElement(errors, "Error");
  return error === null ? null : childText(error, "Code");
}

function errorMessage(document: XmlElement): string | null {
  const errors = childElement(document, "Errors");
  const error = errors === null ? childElement(document, "Error") : childElement(errors, "Error");
  return error === null ? null : childText(error, "Message");
}

function instanceViews(document: XmlElement): InstanceView[] {
  return setItems(document, "reservationSet")
    .flatMap((reservation) => setItems(reservation, "instancesSet"))
    .map((instance) => ({
      id: requiredField(instance, "instanceId", "instance"),
      publicIp: childText(instance, "ipAddress") ?? "",
      state: childText(childElement(instance, "instanceState") ?? instance, "name") ?? "",
    }));
}

function volumeFromEc2(element: XmlElement): Volume {
  const attachment = setItems(element, "attachmentSet")[0];
  const attachedTo = attachment === undefined ? null : childText(attachment, "instanceId");
  const name = setItems(element, "tagSet")
    .find((tag) => childText(tag, "key") === "Name");
  const id = requiredField(element, "volumeId", "volume");
  return {
    id,
    name: (name === undefined ? null : childText(name, "value")) ?? id,
    sizeGb: requiredInteger(element, "size", "volume"),
    location: requiredField(element, "availabilityZone", "volume"),
    status: attachedTo === null || attachedTo === "" ? "available" : "attached",
    attachedTo: attachedTo === "" ? null : attachedTo,
  };
}

function tagParameters(
  prefix: string,
  resourceType: "instance" | "volume",
  name: string,
  workspaceId: string,
): AwsQueryParameters {
  return [
    [`${prefix}.ResourceType`, resourceType],
    [`${prefix}.Tag.1.Key`, "Name"],
    [`${prefix}.Tag.1.Value`, name],
    [`${prefix}.Tag.2.Key`, WORKSPACE_TAG],
    [`${prefix}.Tag.2.Value`, workspaceId],
    [`${prefix}.Tag.3.Key`, PURPOSE_TAG],
    [`${prefix}.Tag.3.Value`, PURPOSE_VALUE],
  ];
}

function validated(value: string, pattern: RegExp, label: string): string {
  if (!pattern.test(value)) throw new Error(`invalid ${label}: ${value}`);
  return value;
}

/** Builds the EC2 adapter around credentials selected at request time. The
 * region and placement knobs remain deployment configuration: an org brings
 * AWS identity, not a second control-plane topology. */
export function awsProviderForCredentials(
  env: AwsProviderEnv,
  credentials: AwsCredentials,
  options: AwsProviderOptions = {},
): AwsProvider {
  const region = env.AWS_REGION ?? "";
  if (region === "") {
    throw new Error("AWS_REGION must be configured for AWS compute");
  }
  const imageId = env.AWS_IMAGE_ID ?? "";
  const subnetId = env.AWS_SUBNET_ID ?? "";
  const settings: AwsProviderSettings = {
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    region: validated(region, REGION_PATTERN, "AWS_REGION"),
    securityGroupIds: (env.AWS_SECURITY_GROUP_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value !== "")
      .map((value) => validated(value, SECURITY_GROUP_ID_PATTERN, "AWS_SECURITY_GROUP_IDS")),
  };
  if (credentials.sessionToken !== undefined && credentials.sessionToken !== "") {
    settings.sessionToken = credentials.sessionToken;
  }
  if (imageId !== "") settings.imageId = validated(imageId, IMAGE_ID_PATTERN, "AWS_IMAGE_ID");
  if (subnetId !== "") settings.subnetId = validated(subnetId, SUBNET_ID_PATTERN, "AWS_SUBNET_ID");
  return new AwsProvider(settings, options);
}

/** Absent, not broken: no AWS variables at all means no provider, and
 * deployments that never configured AWS keep their existing registry. A
 * partially filled configuration throws instead, because silently dropping a
 * provider whose credentials are present hides an operator typo. */
export function awsProviderFromEnv(
  env: AwsProviderEnv,
  options: AwsProviderOptions = {},
): AwsProvider | undefined {
  const accessKeyId = env.AWS_ACCESS_KEY_ID ?? "";
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY ?? "";
  const region = env.AWS_REGION ?? "";
  // Credentials decide whether the provider exists at all. AWS_REGION and the
  // other AWS_* knobs live in wrangler.toml, so they are committed and present
  // in every environment once anyone configures AWS — including tests, CI, and
  // local dev, which legitimately hold no credentials. Treating region-without-
  // credentials as a partial configuration made the whole Worker throw at
  // startup in exactly those environments.
  if (accessKeyId === "" && secretAccessKey === "") return undefined;
  if (accessKeyId === "" || secretAccessKey === "" || region === "") {
    throw new Error(
      "AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_REGION must be set together",
    );
  }
  const credentials: AwsCredentialSettings = {
    accessKeyId,
    secretAccessKey,
  };
  const sessionToken = env.AWS_SESSION_TOKEN ?? "";
  if (sessionToken !== "") credentials.sessionToken = sessionToken;
  return awsProviderForCredentials(env, credentials, options);
}

export class AwsProvider implements VmProvider, VolumeProvider {
  readonly id = "aws";
  private readonly credentials: AwsCredentials;
  private readonly host: string;
  private readonly fetcher: Fetcher;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private cachedImageId: string | null;

  constructor(
    private readonly config: AwsProviderConfig,
    options: AwsProviderOptions = {},
  ) {
    const credentials: AwsCredentialSettings = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    };
    if (config.sessionToken !== undefined) credentials.sessionToken = config.sessionToken;
    this.credentials = credentials;
    this.host = `ec2.${config.region}.amazonaws.com`;
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? sleep;
    this.cachedImageId = config.imageId ?? null;
  }

  capabilities(): ProviderCapabilities {
    return {
      volumes: true,
      maxUserDataBytes: AWS_USER_DATA_RAW_MAX_BYTES,
      webAppTicketsSinceMs: BOX_IMAGE_TICKETS_SINCE_MS,
      webAppViewerGuardsSinceMs: BOX_IMAGE_VIEWER_GUARDS_SINCE_MS,
      webAppSharedSessionsSinceMs: BOX_IMAGE_SHARED_SESSIONS_SINCE_MS,
    };
  }

  ownsMachineType(machineTypeId: string): boolean {
    return parseMachineTypeId(machineTypeId) !== null;
  }

  ownsVmId(vmId: string): boolean {
    return VM_ID_PATTERN.test(vmId);
  }

  bootstrapAptSetup(): string {
    return BOOTSTRAP_APT_SETUP;
  }

  private async ec2(
    action: string,
    parameters: AwsQueryParameters,
    toleratedCodes: readonly string[] = [],
  ): Promise<XmlElement | null> {
    const signed = await signAwsQueryRequest({
      credentials: this.credentials,
      region: this.config.region,
      service: EC2_SERVICE,
      host: this.host,
      parameters: [["Action", action], ["Version", EC2_API_VERSION], ...parameters],
      signedAt: new Date(this.now()),
    });
    const { response, body } = await fetchBoundedText(
      this.fetcher,
      signed.url,
      { method: "POST", headers: signed.headers, body: signed.body },
      { responseLabel: `AWS EC2 ${action}`, bodyDisposition: () => "read" },
    );
    const document = parseXml(body ?? "");
    if (response.ok) return document;
    const code = errorCode(document);
    if (code !== null && toleratedCodes.includes(code)) return null;
    const message = errorMessage(document);
    if (code === null) {
      throw new Error(`AWS EC2 ${action} failed with status ${response.status}`);
    }
    throw new Error(
      message === null
        ? `AWS EC2 ${action} failed: ${sanitize(code)}`
        : `AWS EC2 ${action} failed: ${sanitize(code)}: ${sanitize(message)}`,
    );
  }

  private async required(
    action: string,
    parameters: AwsQueryParameters,
  ): Promise<XmlElement> {
    const document = await this.ec2(action, parameters);
    if (document === null) throw new Error(`AWS EC2 ${action} returned no document`);
    return document;
  }

  async listMachineTypes(): Promise<ProviderMachineType[]> {
    const nowMs = this.now();
    return MACHINE_TYPES.map((machineType) => ({
      id: `aws-${machineType.instanceType}@${this.config.region}`,
      name: machineType.instanceType,
      cpuCores: machineType.cpuCores,
      memGb: machineType.memGb,
      diskGb: machineType.diskGb,
      arch: "x86",
      location: this.config.region,
      monthlyPrice: awsMonthlyPrice(
        this.config.region,
        machineType.instanceType,
        machineType.diskGb,
        nowMs,
      ),
      // AWS sells one line here, so no card ever replaces another.
      standsInFor: null,
    } satisfies ProviderMachineType));
  }

  /** Newest available Canonical Ubuntu 24.04 amd64 image. One call, cached for
   * the isolate. Canonical's non-deprecated set is ~16 images (~37 KiB of XML
   * in us-east-1 on 2026-08-18), inside the 64 KiB bounded-fetch cap; set
   * `AWS_IMAGE_ID` to skip the lookup entirely. */
  private async imageId(): Promise<string> {
    const cached = this.cachedImageId;
    if (cached !== null) return cached;
    const document = await this.required("DescribeImages", [
      ["Owner.1", CANONICAL_OWNER_ID],
      ["Filter.1.Name", "name"],
      ["Filter.1.Value.1", UBUNTU_IMAGE_NAME],
      ["Filter.2.Name", "state"],
      ["Filter.2.Value.1", "available"],
      ["Filter.3.Name", "architecture"],
      ["Filter.3.Value.1", "x86_64"],
    ]);
    let newestId = "";
    let newestDate = "";
    for (const image of setItems(document, "imagesSet")) {
      const created = childText(image, "creationDate") ?? "";
      const candidate = childText(image, "imageId") ?? "";
      if (candidate !== "" && created > newestDate) {
        newestDate = created;
        newestId = candidate;
      }
    }
    if (newestId === "") {
      throw new Error(
        `no Canonical Ubuntu 24.04 amd64 image found in ${this.config.region}; set AWS_IMAGE_ID`,
      );
    }
    this.cachedImageId = newestId;
    return newestId;
  }

  /** Placement parameters. With a configured subnet the request uses the
   * network-interface form so the public IPv4 is explicit; without one it uses
   * the flat form and inherits the default subnet's auto-assign setting. */
  private placementParameters(): AwsQueryParameters {
    const groups = this.config.securityGroupIds ?? [];
    const subnetId = this.config.subnetId;
    if (subnetId === undefined) {
      return groups.map((group, index) => [`SecurityGroupId.${index + 1}`, group]);
    }
    return [
      ["NetworkInterface.1.DeviceIndex", "0"],
      ["NetworkInterface.1.SubnetId", subnetId],
      ["NetworkInterface.1.AssociatePublicIpAddress", "true"],
      ["NetworkInterface.1.DeleteOnTermination", "true"],
      ...groups.map((group, index): readonly [string, string] => [
        `NetworkInterface.1.SecurityGroupId.${index + 1}`,
        group,
      ]),
    ];
  }

  async createVm(input: CreateVmInput): Promise<CreatedVm> {
    const selected = parseMachineTypeId(input.machineTypeId);
    if (selected === null) {
      throw new Error(`unknown AWS machine type: ${input.machineTypeId}`);
    }
    if (selected.region !== this.config.region) {
      throw new Error(
        `machine type ${input.machineTypeId} is not in the configured region ${this.config.region}`,
      );
    }
    const userDataGzip = await gzipUtf8(input.userData);
    if (userDataGzip.byteLength > AWS_USER_DATA_MAX_BYTES) {
      const rawBytes = new TextEncoder().encode(input.userData).byteLength;
      throw new Error(
        `userData is ${userDataGzip.byteLength} bytes gzipped (${rawBytes} raw); EC2 accepts at most ${AWS_USER_DATA_MAX_BYTES}`,
      );
    }
    const diskGb = MACHINE_TYPES
      .find((machineType) => machineType.instanceType === selected.instanceType)
      ?.diskGb ?? DEFAULT_ROOT_DISK_GB;
    const name = `blitz-${input.machineId.slice(0, 12)}`;
    const document = await this.required("RunInstances", [
      ["ImageId", await this.imageId()],
      ["InstanceType", selected.instanceType],
      ["MinCount", "1"],
      ["MaxCount", "1"],
      // Gzipped: cloud-init detects the magic bytes and decompresses, and the
      // EC2 16 KiB cap applies to what is sent, not to the script inside.
      ["UserData", base64Bytes(userDataGzip)],
      ["BlockDeviceMapping.1.DeviceName", ROOT_DEVICE_NAME],
      ["BlockDeviceMapping.1.Ebs.VolumeSize", String(diskGb)],
      ["BlockDeviceMapping.1.Ebs.VolumeType", "gp3"],
      ["BlockDeviceMapping.1.Ebs.DeleteOnTermination", "true"],
      ["MetadataOptions.HttpEndpoint", "enabled"],
      ["MetadataOptions.HttpTokens", "required"],
      ...tagParameters("TagSpecification.1", "instance", name, input.workspaceId),
      ...tagParameters("TagSpecification.2", "volume", name, input.workspaceId),
      ...this.placementParameters(),
    ]);
    const instance = setItems(document, "instancesSet")[0];
    if (instance === undefined) throw new Error("invalid AWS RunInstances response");
    const id = requiredField(instance, "instanceId", "RunInstances");
    const immediate = childText(instance, "ipAddress") ?? "";
    const host = immediate === "" ? await this.waitForPublicIp(id) : immediate;
    return { id, host, port: 22, user: "blitz" };
  }

  /** RunInstances answers before the public IPv4 is attached, so the address
   * has to be read back. Hetzner returns it inline; this is the cost of the
   * EC2 launch flow, not an extra feature. */
  private async waitForPublicIp(id: string): Promise<string> {
    const deadline = this.now() + POLL_TIMEOUT_MS;
    for (;;) {
      const instance = await this.describeInstance(id);
      if (instance !== null && instance.publicIp !== "") return instance.publicIp;
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        throw new Error(`AWS instance ${id} did not receive a public IPv4 address`);
      }
      await this.sleep(Math.min(POLL_INTERVAL_MS, remaining));
    }
  }

  private async describeInstance(id: string): Promise<InstanceView | null> {
    const document = await this.ec2(
      "DescribeInstances",
      [["InstanceId.1", id]],
      INSTANCE_GONE_CODES,
    );
    if (document === null) return null;
    return instanceViews(document).find((instance) => instance.id === id) ?? null;
  }

  async shutdown(id: string): Promise<void> {
    validated(id, VM_ID_PATTERN, "AWS instance id");
    const stopping = await this.ec2("StopInstances", [["InstanceId.1", id]], INSTANCE_GONE_CODES);
    if (stopping === null) return;
    const deadline = this.now() + POLL_TIMEOUT_MS;
    while (this.now() < deadline) {
      const instance = await this.describeInstance(id);
      if (instance === null) return;
      if (instance.state === "stopped" || instance.state === "terminated") return;
      const remaining = deadline - this.now();
      if (remaining <= 0) return;
      await this.sleep(Math.min(POLL_INTERVAL_MS, remaining));
    }
  }

  async destroy(id: string): Promise<void> {
    validated(id, VM_ID_PATTERN, "AWS instance id");
    await this.ec2("TerminateInstances", [["InstanceId.1", id]], INSTANCE_GONE_CODES);
  }

  /** EC2 keeps terminated instances describable for about an hour, so a
   * `terminated` or `shutting-down` state is reported as gone rather than as a
   * live VM the orphan sweep would try to destroy again. `host` is empty for a
   * stopped instance: EC2 releases the auto-assigned public IPv4 on stop. */
  async inspect(id: string): Promise<VmInspection | null> {
    if (!VM_ID_PATTERN.test(id)) return null;
    const instance = await this.describeInstance(id);
    if (instance === null) return null;
    if (instance.state === "terminated" || instance.state === "shutting-down") return null;
    return {
      id: instance.id,
      host: instance.publicIp,
      port: 22,
      user: "blitz",
      state: instance.state === "running" ? "running" : "stopped",
    };
  }

  async createVolume(input: CreateVolumeRequest): Promise<Volume> {
    if (!input.location.startsWith(this.config.region)) {
      throw new Error(
        `volume location ${input.location} must be an availability zone in ${this.config.region}`,
      );
    }
    const document = await this.required("CreateVolume", [
      ["AvailabilityZone", input.location],
      ["Size", String(input.sizeGb)],
      ["VolumeType", "gp3"],
      ["TagSpecification.1.ResourceType", "volume"],
      ["TagSpecification.1.Tag.1.Key", "Name"],
      ["TagSpecification.1.Tag.1.Value", input.name],
      ["TagSpecification.1.Tag.2.Key", PURPOSE_TAG],
      ["TagSpecification.1.Tag.2.Value", PURPOSE_VALUE],
    ]);
    return volumeFromEc2(document);
  }

  /** EBS has no automount: the guest sees a raw block device at
   * `/dev/sdf` (`/dev/nvme1n1` on Nitro) and the box image, which relies on
   * Hetzner's `automount`, does not format or mount it. */
  async attachVolume(volumeId: string, vmId: string): Promise<void> {
    validated(volumeId, VOLUME_ID_PATTERN, "AWS volume id");
    validated(vmId, VM_ID_PATTERN, "AWS instance id");
    await this.required("AttachVolume", [
      ["VolumeId", volumeId],
      ["InstanceId", vmId],
      ["Device", ATTACH_DEVICE_NAME],
    ]);
  }

  async detachVolume(volumeId: string, vmId: string): Promise<void> {
    validated(volumeId, VOLUME_ID_PATTERN, "AWS volume id");
    const document = await this.ec2(
      "DescribeVolumes",
      [["VolumeId.1", volumeId]],
      VOLUME_GONE_CODES,
    );
    if (document === null) return;
    const element = setItems(document, "volumeSet")[0];
    if (element === undefined) return;
    if (volumeFromEc2(element).attachedTo !== vmId) return;
    await this.ec2(
      "DetachVolume",
      [["VolumeId", volumeId], ["InstanceId", vmId]],
      VOLUME_GONE_CODES,
    );
  }

  async deleteVolume(id: string): Promise<void> {
    validated(id, VOLUME_ID_PATTERN, "AWS volume id");
    await this.ec2("DeleteVolume", [["VolumeId", id]], VOLUME_GONE_CODES);
  }

  /** Tag-scoped on purpose. Unlike the dedicated Hetzner project the README
   * mandates, an AWS account routinely holds unrelated volumes, and none of
   * them belong in this listing. */
  async listVolumes(): Promise<Volume[]> {
    const volumes: Volume[] = [];
    let nextToken: string | null = null;
    for (;;) {
      const parameters: (readonly [string, string])[] = [
        ["Filter.1.Name", `tag:${PURPOSE_TAG}`],
        ["Filter.1.Value.1", PURPOSE_VALUE],
      ];
      if (nextToken !== null) parameters.push(["NextToken", nextToken]);
      const page: XmlElement = await this.required("DescribeVolumes", parameters);
      volumes.push(...setItems(page, "volumeSet").map(volumeFromEc2));
      const token = childText(page, "nextToken");
      if (token === null || token === "") return volumes;
      nextToken = token;
    }
  }
}
