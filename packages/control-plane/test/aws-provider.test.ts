import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rawDb } from "../src/raw-db.js";
import { HetznerProvider } from "../core/compute/hetzner.js";
import { MicrovmPoolProvider } from "../core/compute/microvm.js";
import { VmProviderRegistry } from "../core/compute/registry.js";
import {
  AWS_USER_DATA_MAX_BYTES,
  AWS_USER_DATA_RAW_MAX_BYTES,
  AwsProvider,
  awsProviderFromEnv,
  type AwsProviderConfig,
} from "../core/compute/aws.js";
import { signAwsQueryRequest } from "../core/compute/aws-sigv4.js";
import { parseXml, childText, setItems } from "../core/compute/aws-xml.js";
import type { CreateVmInput } from "../core/compute/types.js";

const REGION = "us-east-1";
const INSTANCE_ID = "i-0123456789abcdef0";
const IMAGE_ID = "ami-0123456789abcdef0";
const NOW_MS = Date.UTC(2026, 7, 18, 12, 0, 0);
const PHONE_HOME_URL = "https://cp.example/workspaces/workspace-id/phone-home/capability";

interface Ec2Reply {
  readonly status: number;
  readonly xml: string;
}

interface Ec2Call {
  readonly url: string;
  readonly action: string;
  readonly authorization: string;
  readonly amzDate: string;
  readonly contentType: string;
  readonly body: string;
  readonly parameters: URLSearchParams;
}

type Ec2Handler = (action: string, parameters: URLSearchParams) => Ec2Reply;

interface FakeEc2 {
  readonly calls: Ec2Call[];
  readonly fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

function headerValue(init: RequestInit | undefined, name: string): string {
  const headers = init?.headers;
  if (!Array.isArray(headers)) return "";
  for (const entry of headers) {
    if (Array.isArray(entry) && entry[0] === name) return String(entry[1]);
  }
  return "";
}

function fakeEc2(handler: Ec2Handler): FakeEc2 {
  const calls: Ec2Call[] = [];
  return {
    calls,
    fetcher: async (input, init) => {
      const body = String(init?.body ?? "");
      const parameters = new URLSearchParams(body);
      const action = parameters.get("Action") ?? "";
      calls.push({
        url: String(input),
        action,
        authorization: headerValue(init, "authorization"),
        amzDate: headerValue(init, "x-amz-date"),
        contentType: headerValue(init, "content-type"),
        body,
        parameters,
      });
      const reply = handler(action, parameters);
      return new Response(reply.xml, {
        status: reply.status,
        headers: { "content-type": "text/xml;charset=UTF-8" },
      });
    },
  };
}

// The provider reads global fetch and the real clock. Fake timers pin the
// signing date to NOW_MS and let the bounded poll loops run without waiting;
// each provider() call points global fetch at that test's fake EC2.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function provider(fake: FakeEc2, overrides: Partial<AwsProviderConfig> = {}): AwsProvider {
  vi.stubGlobal("fetch", fake.fetcher);
  return new AwsProvider({
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    region: REGION,
    imageId: IMAGE_ID,
    ...overrides,
  });
}

function createInput(machineTypeId: string, userData = "#!/bin/bash\necho hi\n"): CreateVmInput {
  return {
    workspaceId: "workspace-id-0123456789",
    machineTypeId,
    phoneHomeUrl: PHONE_HOME_URL,
    userData,
  };
}

function ok(xml: string): Ec2Reply {
  return { status: 200, xml: `<?xml version="1.0" encoding="UTF-8"?>${xml}` };
}

function ec2Error(code: string, message: string, status = 400): Ec2Reply {
  return {
    status,
    xml: `<?xml version="1.0" encoding="UTF-8"?><Response><Errors><Error>`
      + `<Code>${code}</Code><Message>${message}</Message>`
      + `</Error></Errors><RequestID>request-id</RequestID></Response>`,
  };
}

function runInstances(publicIp: string): Ec2Reply {
  const address = publicIp === "" ? "" : `<ipAddress>${publicIp}</ipAddress>`;
  return ok(
    `<RunInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">`
      + `<requestId>request-id</requestId><reservationId>r-1</reservationId>`
      + `<instancesSet><item><instanceId>${INSTANCE_ID}</instanceId>`
      + `<instanceState><code>0</code><name>pending</name></instanceState>`
      + `<privateIpAddress>10.0.1.5</privateIpAddress>${address}`
      + `</item></instancesSet></RunInstancesResponse>`,
  );
}

function describeInstances(state: string, publicIp: string): Ec2Reply {
  const address = publicIp === "" ? "" : `<ipAddress>${publicIp}</ipAddress>`;
  return ok(
    `<DescribeInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">`
      + `<requestId>request-id</requestId><reservationSet><item>`
      + `<reservationId>r-1</reservationId><instancesSet><item>`
      + `<instanceId>${INSTANCE_ID}</instanceId>${address}`
      + `<instanceState><code>16</code><name>${state}</name></instanceState>`
      + `</item></instancesSet></item></reservationSet></DescribeInstancesResponse>`,
  );
}

describe("AWS provider ownership", () => {
  it("claims aws- machine types and i- VM ids without colliding with the other providers", () => {
    const aws = provider(fakeEc2(() => ok("<Response/>")));
    const hetzner = new HetznerProvider("test-token");
    const microvm = new MicrovmPoolProvider("[]", () => undefined, { db: rawDb(env.DB) });
    const registry = new VmProviderRegistry([hetzner, microvm, aws]);

    expect(registry.forMachineType("aws-t3.medium@us-east-1")).toBe(aws);
    expect(registry.forMachineType("aws-m6i.xlarge@eu-west-1")).toBe(aws);
    expect(registry.forMachineType("cpx21@hil")).toBe(hetzner);
    expect(registry.forVmId(INSTANCE_ID)).toBe(aws);
    expect(registry.forVmId("i-0abcdef0")).toBe(aws);
    expect(registry.forVmId("42")).toBe(hetzner);

    expect(aws.ownsMachineType("cpx21@hil")).toBe(false);
    expect(aws.ownsMachineType("mv-2c2g@lab")).toBe(false);
    expect(aws.ownsMachineType("aws-t3.medium")).toBe(false);
    expect(aws.ownsVmId("42")).toBe(false);
    expect(aws.ownsVmId("microvm:v1:lab:1")).toBe(false);
    expect(aws.ownsVmId("i-0123456789ABCDEF0")).toBe(false);
  });

  it("advertises the gzip-backed raw user-data budget in its capabilities", () => {
    expect(AWS_USER_DATA_MAX_BYTES).toBe(16_384);
    expect(AWS_USER_DATA_RAW_MAX_BYTES).toBe(49_152);
    expect(provider(fakeEc2(() => ok("<Response/>"))).capabilities()).toEqual({
      volumes: false,
      maxUserDataBytes: 49_152,
      webAppTicketsSinceMs: 1_786_993_800_000,
      webAppViewerGuardsSinceMs: 1_787_043_600_000,
    });
  });

  it("lists a curated catalog stamped with the configured region", async () => {
    const machineTypes = await provider(
      fakeEc2(() => ok("<Response/>")),
      { region: "eu-west-1" },
    ).listMachineTypes();

    expect(machineTypes.map((machineType) => machineType.id)).toEqual([
      "aws-t3.medium@eu-west-1",
      "aws-t3.large@eu-west-1",
      "aws-m6i.large@eu-west-1",
      "aws-m6i.xlarge@eu-west-1",
    ]);
    expect(machineTypes[0]).toEqual({
      id: "aws-t3.medium@eu-west-1",
      name: "t3.medium",
      cpuCores: 2,
      memGb: 4,
      diskGb: 40,
      arch: "x86",
      location: "eu-west-1",
    });
    expect(machineTypes.every((machineType) => machineType.arch === "x86")).toBe(true);
  });
});

describe("AWS provider createVm", () => {
  it("signs a RunInstances query carrying base64 user data, tags, and IMDSv2", async () => {
    const fake = fakeEc2((action) =>
      action === "RunInstances" ? runInstances("203.0.113.10") : ec2Error("Unexpected", action)
    );
    const userData = "#!/bin/bash\necho é\n";

    const created = await provider(fake).createVm(
      createInput("aws-m6i.large@us-east-1", userData),
    );

    expect(created).toEqual({
      id: INSTANCE_ID,
      host: "203.0.113.10",
      port: 22,
      user: "blitz",
    });
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    if (call === undefined) throw new Error("expected a RunInstances call");
    expect(call.url).toBe("https://ec2.us-east-1.amazonaws.com/");
    expect(call.contentType).toBe("application/x-www-form-urlencoded");
    // The signed body embeds base64(gzip(userData)), and workerd's
    // CompressionStream emits different deflate bytes on different platform
    // builds (linux vs darwin), so a golden signature cannot hold on both.
    // Instead, re-sign the captured request with the exported signer under the
    // same credentials, scope, and clock: a drift in the parameter set, its
    // order, the date wiring, or the key still breaks the match. Correctness
    // of the algorithm itself is proved in `aws-sigv4.test.ts` against the
    // published AWS vector, whose input is deterministic.
    expect(call.amzDate).toBe("20260818T120000Z");
    expect(call.authorization).toContain(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260818/us-east-1/ec2/aws4_request,"
        + " SignedHeaders=content-type;host;x-amz-date,"
        + " Signature=",
    );
    const resigned = await signAwsQueryRequest({
      credentials: {
        accessKeyId: "AKIDEXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      },
      region: REGION,
      service: "ec2",
      host: "ec2.us-east-1.amazonaws.com",
      parameters: [...call.parameters],
      signedAt: new Date(NOW_MS),
    });
    // The captured parameters must re-encode to the exact bytes the provider
    // sent, or the re-signed request would prove nothing about the wire one.
    expect(resigned.body).toBe(call.body);
    expect(call.authorization).toBe(
      resigned.headers.find(([name]) => name === "authorization")?.[1] ?? "",
    );
    expect(call.parameters.get("Version")).toBe("2016-11-15");
    expect(call.parameters.get("ImageId")).toBe(IMAGE_ID);
    expect(call.parameters.get("InstanceType")).toBe("m6i.large");
    expect(call.parameters.get("MinCount")).toBe("1");
    expect(call.parameters.get("MaxCount")).toBe("1");
    // The wire carries gzip (cloud-init decompresses); prove the payload
    // round-trips to the exact script.
    const sentBytes = Uint8Array.from(
      atob(call.parameters.get("UserData") ?? ""),
      (character) => character.charCodeAt(0),
    );
    expect(sentBytes[0]).toBe(0x1f);
    expect(sentBytes[1]).toBe(0x8b);
    const inflated = await new Response(
      new Blob([sentBytes]).stream().pipeThrough(new DecompressionStream("gzip")),
    ).text();
    expect(inflated).toBe(userData);
    expect(call.parameters.get("BlockDeviceMapping.1.DeviceName")).toBe("/dev/sda1");
    expect(call.parameters.get("BlockDeviceMapping.1.Ebs.VolumeSize")).toBe("60");
    expect(call.parameters.get("BlockDeviceMapping.1.Ebs.VolumeType")).toBe("gp3");
    expect(call.parameters.get("BlockDeviceMapping.1.Ebs.DeleteOnTermination")).toBe("true");
    expect(call.parameters.get("MetadataOptions.HttpTokens")).toBe("required");
    expect(call.parameters.get("TagSpecification.1.ResourceType")).toBe("instance");
    expect(call.parameters.get("TagSpecification.1.Tag.2.Key")).toBe("blitz-workspace");
    expect(call.parameters.get("TagSpecification.1.Tag.2.Value")).toBe("workspace-id-0123456789");
    expect(call.parameters.get("TagSpecification.1.Tag.3.Key")).toBe("blitz-purpose");
    expect(call.parameters.get("TagSpecification.2.ResourceType")).toBe("volume");
    expect(call.parameters.get("NetworkInterface.1.DeviceIndex")).toBeNull();
  });

  it("uses the network-interface form and requests a public IPv4 when a subnet is pinned", async () => {
    const fake = fakeEc2(() => runInstances("203.0.113.10"));

    await provider(fake, {
      subnetId: "subnet-0123456789abcdef0",
      securityGroupIds: ["sg-0123456789abcdef0", "sg-00000000000000001"],
    }).createVm(createInput("aws-t3.medium@us-east-1"));

    const call = fake.calls[0];
    if (call === undefined) throw new Error("expected a RunInstances call");
    expect(call.parameters.get("NetworkInterface.1.DeviceIndex")).toBe("0");
    expect(call.parameters.get("NetworkInterface.1.SubnetId")).toBe("subnet-0123456789abcdef0");
    expect(call.parameters.get("NetworkInterface.1.AssociatePublicIpAddress")).toBe("true");
    expect(call.parameters.get("NetworkInterface.1.SecurityGroupId.1")).toBe("sg-0123456789abcdef0");
    expect(call.parameters.get("NetworkInterface.1.SecurityGroupId.2")).toBe("sg-00000000000000001");
    expect(call.parameters.get("SecurityGroupId.1")).toBeNull();
  });

  it("passes flat security groups when no subnet is pinned", async () => {
    const fake = fakeEc2(() => runInstances("203.0.113.10"));

    await provider(fake, { securityGroupIds: ["sg-0123456789abcdef0"] })
      .createVm(createInput("aws-t3.medium@us-east-1"));

    const call = fake.calls[0];
    if (call === undefined) throw new Error("expected a RunInstances call");
    expect(call.parameters.get("SecurityGroupId.1")).toBe("sg-0123456789abcdef0");
    expect(call.parameters.get("NetworkInterface.1.SubnetId")).toBeNull();
  });

  it("polls DescribeInstances when RunInstances answers before the public IPv4 exists", async () => {
    let describes = 0;
    const fake = fakeEc2((action) => {
      if (action === "RunInstances") return runInstances("");
      describes += 1;
      return describes < 3
        ? describeInstances("pending", "")
        : describeInstances("running", "203.0.113.11");
    });

    const pending = provider(fake).createVm(createInput("aws-t3.medium@us-east-1"));
    await vi.runAllTimersAsync();
    const created = await pending;

    expect(created.host).toBe("203.0.113.11");
    expect(fake.calls.map((call) => call.action)).toEqual([
      "RunInstances",
      "DescribeInstances",
      "DescribeInstances",
      "DescribeInstances",
    ]);
  });

  it("gives up on the public IPv4 once the bounded poll window closes", async () => {
    const fake = fakeEc2((action) =>
      action === "RunInstances" ? runInstances("") : describeInstances("pending", "")
    );

    const expectation = expect(provider(fake).createVm(createInput("aws-t3.medium@us-east-1")))
      .rejects.toThrow(`AWS instance ${INSTANCE_ID} did not receive a public IPv4 address`);
    await vi.runAllTimersAsync();
    await expectation;
  });

  it("refuses user data whose gzip exceeds EC2's cap, before the API", async () => {
    const fake = fakeEc2(() => runInstances("203.0.113.10"));
    // Incompressible payload: gzip cannot shrink random bytes, so 20 KiB of
    // them lands over the 16 KiB wire cap. A compressible script of the same
    // raw size sails through — that asymmetry is the feature.
    const randomBytes = new Uint8Array(20 * 1024);
    crypto.getRandomValues(randomBytes);
    let incompressible = "";
    for (const byte of randomBytes) incompressible += String.fromCharCode(byte % 94 + 33);

    await expect(
      provider(fake).createVm(createInput("aws-t3.medium@us-east-1", incompressible)),
    ).rejects.toThrow("EC2 accepts at most 16384");
    expect(fake.calls).toHaveLength(0);

    await expect(
      provider(fake).createVm(
        createInput("aws-t3.medium@us-east-1", "#".repeat(AWS_USER_DATA_RAW_MAX_BYTES)),
      ),
    ).resolves.toMatchObject({ id: INSTANCE_ID });
  });

  it("rejects machine types it does not own or that name another region", async () => {
    const fake = fakeEc2(() => runInstances("203.0.113.10"));

    await expect(provider(fake).createVm(createInput("cpx21@hil")))
      .rejects.toThrow("unknown AWS machine type: cpx21@hil");
    await expect(provider(fake).createVm(createInput("aws-t3.medium@eu-west-1")))
      .rejects.toThrow(
        "machine type aws-t3.medium@eu-west-1 is not in the configured region us-east-1",
      );
    expect(fake.calls).toHaveLength(0);
  });

  it("surfaces the EC2 error code and message", async () => {
    const fake = fakeEc2(() =>
      ec2Error("InsufficientInstanceCapacity", "We currently do not have enough capacity.")
    );

    await expect(provider(fake).createVm(createInput("aws-t3.medium@us-east-1")))
      .rejects.toThrow(
        "AWS EC2 RunInstances failed: InsufficientInstanceCapacity:"
          + " We currently do not have enough capacity.",
      );
  });

  it("resolves and caches the newest Canonical image when no AMI is pinned", async () => {
    const fake = fakeEc2((action) => {
      if (action === "DescribeImages") {
        return ok(
          `<DescribeImagesResponse><imagesSet>`
            + `<item><imageId>ami-00000000000000001</imageId>`
            + `<creationDate>2026-01-05T00:00:00.000Z</creationDate></item>`
            + `<item><imageId>ami-00000000000000009</imageId>`
            + `<creationDate>2026-07-14T11:54:50.000Z</creationDate></item>`
            + `<item><imageId>ami-00000000000000002</imageId>`
            + `<creationDate>2026-04-09T14:13:23.000Z</creationDate></item>`
            + `</imagesSet></DescribeImagesResponse>`,
        );
      }
      return runInstances("203.0.113.10");
    });
    const aws = provider(fake, { imageId: undefined });

    await aws.createVm(createInput("aws-t3.medium@us-east-1"));
    await aws.createVm(createInput("aws-t3.medium@us-east-1"));

    expect(fake.calls.map((call) => call.action)).toEqual([
      "DescribeImages",
      "RunInstances",
      "RunInstances",
    ]);
    const images = fake.calls[0];
    if (images === undefined) throw new Error("expected a DescribeImages call");
    expect(images.parameters.get("Owner.1")).toBe("099720109477");
    expect(images.parameters.get("Filter.1.Value.1")).toBe(
      "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*",
    );
    expect(images.parameters.get("Filter.3.Value.1")).toBe("x86_64");
    expect(fake.calls[1]?.parameters.get("ImageId")).toBe("ami-00000000000000009");
    expect(fake.calls[2]?.parameters.get("ImageId")).toBe("ami-00000000000000009");
  });

  it("explains an empty image lookup instead of launching without an AMI", async () => {
    const fake = fakeEc2(() => ok("<DescribeImagesResponse><imagesSet/></DescribeImagesResponse>"));

    await expect(
      provider(fake, { imageId: undefined }).createVm(createInput("aws-t3.medium@us-east-1")),
    ).rejects.toThrow("no Canonical Ubuntu 24.04 amd64 image found in us-east-1; set AWS_IMAGE_ID");
  });
});

describe("AWS provider lifecycle", () => {
  it("stops an instance and waits for the stopped state", async () => {
    let describes = 0;
    const fake = fakeEc2((action) => {
      if (action === "StopInstances") {
        return ok(
          `<StopInstancesResponse><instancesSet><item>`
            + `<instanceId>${INSTANCE_ID}</instanceId>`
            + `<currentState><name>stopping</name></currentState>`
            + `</item></instancesSet></StopInstancesResponse>`,
        );
      }
      describes += 1;
      return describes < 2
        ? describeInstances("stopping", "203.0.113.10")
        : describeInstances("stopped", "");
    });

    const pending = provider(fake).shutdown(INSTANCE_ID);
    await vi.runAllTimersAsync();
    await pending;

    expect(fake.calls.map((call) => call.action)).toEqual([
      "StopInstances",
      "DescribeInstances",
      "DescribeInstances",
    ]);
  });

  it("treats a missing instance as an already-completed stop", async () => {
    const fake = fakeEc2(() =>
      ec2Error("InvalidInstanceID.NotFound", `The instance ID '${INSTANCE_ID}' does not exist`)
    );

    await expect(provider(fake).shutdown(INSTANCE_ID)).resolves.toBeUndefined();
    expect(fake.calls.map((call) => call.action)).toEqual(["StopInstances"]);
  });

  it("terminates idempotently: an already-terminated instance is success", async () => {
    const gone = fakeEc2(() =>
      ec2Error("InvalidInstanceID.NotFound", `The instance ID '${INSTANCE_ID}' does not exist`)
    );
    const live = fakeEc2(() =>
      ok(
        `<TerminateInstancesResponse><instancesSet><item>`
          + `<instanceId>${INSTANCE_ID}</instanceId>`
          + `<currentState><name>shutting-down</name></currentState>`
          + `</item></instancesSet></TerminateInstancesResponse>`,
      )
    );

    await expect(provider(gone).destroy(INSTANCE_ID)).resolves.toBeUndefined();
    await expect(provider(live).destroy(INSTANCE_ID)).resolves.toBeUndefined();
    expect(gone.calls[0]?.parameters.get("InstanceId.1")).toBe(INSTANCE_ID);
    expect(live.calls[0]?.action).toBe("TerminateInstances");
  });

  it("propagates a terminate failure that is not a missing instance", async () => {
    const fake = fakeEc2(() =>
      ec2Error("UnauthorizedOperation", "You are not authorized to perform this operation.", 403)
    );

    await expect(provider(fake).destroy(INSTANCE_ID)).rejects.toThrow(
      "AWS EC2 TerminateInstances failed: UnauthorizedOperation:"
        + " You are not authorized to perform this operation.",
    );
  });

  it("inspects running, stopped, terminated, and missing instances", async () => {
    const running = fakeEc2(() => describeInstances("running", "203.0.113.10"));
    const stopped = fakeEc2(() => describeInstances("stopped", ""));
    const terminated = fakeEc2(() => describeInstances("terminated", ""));
    const shuttingDown = fakeEc2(() => describeInstances("shutting-down", "203.0.113.10"));
    const gone = fakeEc2(() =>
      ec2Error("InvalidInstanceID.NotFound", `The instance ID '${INSTANCE_ID}' does not exist`)
    );

    await expect(provider(running).inspect(INSTANCE_ID)).resolves.toEqual({
      id: INSTANCE_ID,
      host: "203.0.113.10",
      port: 22,
      user: "blitz",
      state: "running",
    });
    await expect(provider(stopped).inspect(INSTANCE_ID)).resolves.toEqual({
      id: INSTANCE_ID,
      host: "",
      port: 22,
      user: "blitz",
      state: "stopped",
    });
    await expect(provider(terminated).inspect(INSTANCE_ID)).resolves.toBeNull();
    await expect(provider(shuttingDown).inspect(INSTANCE_ID)).resolves.toBeNull();
    await expect(provider(gone).inspect(INSTANCE_ID)).resolves.toBeNull();
  });

  it("returns null for an id it does not own without calling EC2", async () => {
    const fake = fakeEc2(() => describeInstances("running", "203.0.113.10"));

    await expect(provider(fake).inspect("42")).resolves.toBeNull();
    expect(fake.calls).toHaveLength(0);
  });
});

describe("AWS provider configuration", () => {
  it("is absent, not broken, when no AWS variable is set", () => {
    expect(awsProviderFromEnv({})).toBeUndefined();
    expect(awsProviderFromEnv({
      AWS_ACCESS_KEY_ID: "",
      AWS_SECRET_ACCESS_KEY: "",
      AWS_REGION: "",
    })).toBeUndefined();
  });

  it("fails loudly on a half-filled configuration", () => {
    expect(() => awsProviderFromEnv({ AWS_ACCESS_KEY_ID: "AKIDEXAMPLE" })).toThrow(
      "AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_REGION must be set together",
    );
    expect(() =>
      awsProviderFromEnv({
        AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
        AWS_SECRET_ACCESS_KEY: "secret",
        AWS_REGION: "nowhere",
      })
    ).toThrow("invalid AWS_REGION: nowhere");
    expect(() =>
      awsProviderFromEnv({
        AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
        AWS_SECRET_ACCESS_KEY: "secret",
        AWS_REGION: REGION,
        AWS_SECURITY_GROUP_IDS: "sg-0123456789abcdef0, not-a-group",
      })
    ).toThrow("invalid AWS_SECURITY_GROUP_IDS: not-a-group");
  });

  it("builds a provider from a complete configuration", async () => {
    const aws = awsProviderFromEnv({
      AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_REGION: "eu-west-1",
      AWS_IMAGE_ID: IMAGE_ID,
      AWS_SUBNET_ID: "subnet-0123456789abcdef0",
      AWS_SECURITY_GROUP_IDS: " sg-0123456789abcdef0 , sg-00000000000000001 ",
    });
    if (aws === undefined) throw new Error("expected a configured AWS provider");

    expect(aws.id).toBe("aws");
    expect((await aws.listMachineTypes())[0]?.id).toBe("aws-t3.medium@eu-west-1");
  });
});

describe("EC2 XML reading", () => {
  it("reads nested sets, entities, self-closing elements, and comments", () => {
    const document = parseXml(
      `<?xml version="1.0" encoding="UTF-8"?>`
        + `<!-- a comment --><DescribeVolumesResponse xmlns="http://example">`
        + `<requestId>r &amp; d</requestId><volumeSet>`
        + `<item><volumeId>vol-1</volumeId><attachmentSet/></item>`
        + `<item><volumeId>vol-2</volumeId>`
        + `<tagSet><item><key>Name</key><value>a &lt;b&gt; c</value></item></tagSet>`
        + `</item></volumeSet></DescribeVolumesResponse>`,
    );

    expect(document.name).toBe("DescribeVolumesResponse");
    expect(childText(document, "requestId")).toBe("r & d");
    expect(setItems(document, "volumeSet").map((item) => childText(item, "volumeId")))
      .toEqual(["vol-1", "vol-2"]);
    const second = setItems(document, "volumeSet")[1];
    if (second === undefined) throw new Error("expected a second volume");
    expect(setItems(second, "tagSet").map((tag) => childText(tag, "value")))
      .toEqual(["a <b> c"]);
    expect(childText(document, "missing")).toBeNull();
    expect(setItems(document, "missingSet")).toEqual([]);
  });

  it("survives an empty, elementless, or truncated body without throwing", () => {
    expect(parseXml("")).toEqual({ name: "", text: "", children: [] });
    expect(parseXml("not xml at all")).toEqual({ name: "", text: "", children: [] });
    expect(parseXml("<Response><Errors>").name).toBe("Response");
    expect(childText(parseXml("<Response><Code>Throttling</Code>"), "Code")).toBe("Throttling");
  });
});
