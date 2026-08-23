import {
  BOX_IMAGE_TICKETS_SINCE_MS,
  BOX_IMAGE_VIEWER_GUARDS_SINCE_MS,
} from "../webapp-tickets.js";
import { fetchBoundedText } from "./json-fetch.js";
import {
  signAwsQueryRequest,
  type AwsCredentials,
  type AwsQueryParameters,
} from "./aws-sigv4.js";
import { childElement, childText, parseXml, setItems, type XmlElement } from "./aws-xml.js";
import type {
  CreatedVm,
  CreateVmInput,
  ProviderCapabilities,
  ProviderMachineType,
  VmInspection,
  VmProvider,
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
 * `aws-t3.medium@us-east-1`. The `aws-` prefix cannot collide with microVM
 * (`mv-`) or Hetzner (`^[a-z]+\d+$` before the `@`) ids. */
const MACHINE_TYPE_PATTERN =
  /^aws-([a-z][a-z0-9]*\.[a-z0-9]+)@([a-z]{2}(?:-[a-z]+)+-\d+)$/u;
const REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-\d+$/u;
/** VM ids are the raw EC2 instance id: `i-` plus 8 or 17 lowercase hex digits. */
const VM_ID_PATTERN = /^i-[0-9a-f]{8}(?:[0-9a-f]{9})?$/u;
const SECURITY_GROUP_ID_PATTERN = /^sg-[0-9a-f]{8}(?:[0-9a-f]{9})?$/u;
const SUBNET_ID_PATTERN = /^subnet-[0-9a-f]{8}(?:[0-9a-f]{9})?$/u;
const IMAGE_ID_PATTERN = /^ami-[0-9a-f]{8}(?:[0-9a-f]{9})?$/u;

const CANONICAL_OWNER_ID = "099720109477";
const UBUNTU_IMAGE_NAME =
  "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*";
const ROOT_DEVICE_NAME = "/dev/sda1";
const DEFAULT_ROOT_DISK_GB = 40;
const WORKSPACE_TAG = "blitz-workspace";
const PURPOSE_TAG = "blitz-purpose";
const PURPOSE_VALUE = "workspace";

const POLL_INTERVAL_MS = 1_000;
const POLL_TIMEOUT_MS = 45_000;

const INSTANCE_GONE_CODES = ["InvalidInstanceID.NotFound", "InvalidInstanceId.NotFound"];

interface AwsMachineType {
  readonly instanceType: string;
  readonly cpuCores: number;
  readonly memGb: number;
  readonly diskGb: number;
}

/** Curated, hardcoded catalog — no live Pricing API call. Specs verified with
 * `ec2 DescribeInstanceTypes` in us-east-1 on 2026-08-18. On-demand Linux
 * prices for us-east-1, same date, are t3.medium $0.0416/h, t3.large
 * $0.0832/h, m6i.large $0.096/h, m6i.xlarge $0.192/h; `diskGb` is the gp3 root
 * volume this provider requests, which is billed separately from the instance.
 *
 * x86_64 only, deliberately: the box image published in `wrangler.toml` is an
 * amd64 tag, so an arm64 instance type would boot and then fail to pull it. */
const MACHINE_TYPES: readonly AwsMachineType[] = [
  { instanceType: "t3.medium", cpuCores: 2, memGb: 4, diskGb: 40 },
  { instanceType: "t3.large", cpuCores: 2, memGb: 8, diskGb: 60 },
  { instanceType: "m6i.large", cpuCores: 2, memGb: 8, diskGb: 60 },
  { instanceType: "m6i.xlarge", cpuCores: 4, memGb: 16, diskGb: 80 },
];

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

/** Absent, not broken: no AWS variables at all means no provider, and
 * deployments that never configured AWS keep their existing registry. A
 * partially filled configuration throws instead, because silently dropping a
 * provider whose credentials are present hides an operator typo. */
export function awsProviderFromEnv(
  env: AwsProviderEnv,
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
  const sessionToken = env.AWS_SESSION_TOKEN ?? "";
  const imageId = env.AWS_IMAGE_ID ?? "";
  const subnetId = env.AWS_SUBNET_ID ?? "";
  const settings: AwsProviderSettings = {
    accessKeyId,
    secretAccessKey,
    region: validated(region, REGION_PATTERN, "AWS_REGION"),
    securityGroupIds: (env.AWS_SECURITY_GROUP_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value !== "")
      .map((value) => validated(value, SECURITY_GROUP_ID_PATTERN, "AWS_SECURITY_GROUP_IDS")),
  };
  if (sessionToken !== "") settings.sessionToken = sessionToken;
  if (imageId !== "") settings.imageId = validated(imageId, IMAGE_ID_PATTERN, "AWS_IMAGE_ID");
  if (subnetId !== "") settings.subnetId = validated(subnetId, SUBNET_ID_PATTERN, "AWS_SUBNET_ID");
  return new AwsProvider(settings);
}

export class AwsProvider implements VmProvider {
  readonly id = "aws";
  private readonly credentials: AwsCredentials;
  private readonly host: string;
  private cachedImageId: string | null;

  constructor(private readonly config: AwsProviderConfig) {
    const credentials: AwsCredentialSettings = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    };
    if (config.sessionToken !== undefined) credentials.sessionToken = config.sessionToken;
    this.credentials = credentials;
    this.host = `ec2.${config.region}.amazonaws.com`;
    this.cachedImageId = config.imageId ?? null;
  }

  capabilities(): ProviderCapabilities {
    // volumes: false — production routes `providers.volume` to Hetzner, so an
    // EBS implementation here would never be called; the create route's volume
    // gate refuses AWS machine types instead.
    return {
      volumes: false,
      maxUserDataBytes: AWS_USER_DATA_RAW_MAX_BYTES,
      webAppTicketsSinceMs: BOX_IMAGE_TICKETS_SINCE_MS,
      webAppViewerGuardsSinceMs: BOX_IMAGE_VIEWER_GUARDS_SINCE_MS,
    };
  }

  ownsMachineType(machineTypeId: string): boolean {
    return parseMachineTypeId(machineTypeId) !== null;
  }

  ownsVmId(vmId: string): boolean {
    return VM_ID_PATTERN.test(vmId);
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
      signedAt: new Date(),
    });
    const { response, body } = await fetchBoundedText(
      fetch,
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
    return MACHINE_TYPES.map((machineType) => ({
      id: `aws-${machineType.instanceType}@${this.config.region}`,
      name: machineType.instanceType,
      cpuCores: machineType.cpuCores,
      memGb: machineType.memGb,
      diskGb: machineType.diskGb,
      arch: "x86",
      location: this.config.region,
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
    const name = `blitz-${input.workspaceId.slice(0, 12)}`;
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
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    for (;;) {
      const instance = await this.describeInstance(id);
      if (instance !== null && instance.publicIp !== "") return instance.publicIp;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`AWS instance ${id} did not receive a public IPv4 address`);
      }
      await sleep(Math.min(POLL_INTERVAL_MS, remaining));
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
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const instance = await this.describeInstance(id);
      if (instance === null) return;
      if (instance.state === "stopped" || instance.state === "terminated") return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      await sleep(Math.min(POLL_INTERVAL_MS, remaining));
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
}
