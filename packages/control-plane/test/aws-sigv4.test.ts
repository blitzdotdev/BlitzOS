import { describe, expect, it } from "vitest";
import {
  amzDateStamp,
  encodeAwsQueryBody,
  encodeAwsQueryComponent,
  signAwsQueryRequest,
} from "../core/compute/aws-sigv4.js";

/** The credentials, host, service, and timestamp published with the AWS
 * Signature Version 4 test suite. Every expectation below that quotes a
 * signature comes from that suite, not from this implementation. */
const SUITE_ACCESS_KEY_ID = "AKIDEXAMPLE";
const SUITE_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const SUITE_HOST = "example.amazonaws.com";
const SUITE_SIGNED_AT = new Date(Date.UTC(2015, 7, 30, 12, 36, 0));

function authorizationOf(headers: readonly (readonly [string, string])[]): string {
  return headers.find(([name]) => name === "authorization")?.[1] ?? "";
}

function headerNames(headers: readonly (readonly [string, string])[]): string[] {
  return headers.map(([name]) => name);
}

describe("AWS SigV4 query signing", () => {
  it("reproduces the published post-x-www-form-urlencoded test-suite vector", async () => {
    const signed = await signAwsQueryRequest({
      credentials: {
        accessKeyId: SUITE_ACCESS_KEY_ID,
        secretAccessKey: SUITE_SECRET_ACCESS_KEY,
      },
      region: "us-east-1",
      service: "service",
      host: SUITE_HOST,
      parameters: [["Param1", "value1"]],
      signedAt: SUITE_SIGNED_AT,
      contentType: "application/x-www-form-urlencoded",
    });

    expect(signed.url).toBe("https://example.amazonaws.com/");
    expect(signed.body).toBe("Param1=value1");
    expect(authorizationOf(signed.headers)).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request,"
        + " SignedHeaders=content-type;host;x-amz-date,"
        + " Signature=ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a",
    );
  });

  it("signs the security token header for temporary credentials", async () => {
    const withoutToken = await signAwsQueryRequest({
      credentials: {
        accessKeyId: SUITE_ACCESS_KEY_ID,
        secretAccessKey: SUITE_SECRET_ACCESS_KEY,
      },
      region: "us-east-1",
      service: "ec2",
      host: SUITE_HOST,
      parameters: [["Action", "DescribeRegions"]],
      signedAt: SUITE_SIGNED_AT,
    });
    const withToken = await signAwsQueryRequest({
      credentials: {
        accessKeyId: SUITE_ACCESS_KEY_ID,
        secretAccessKey: SUITE_SECRET_ACCESS_KEY,
        sessionToken: "session-token-value",
      },
      region: "us-east-1",
      service: "ec2",
      host: SUITE_HOST,
      parameters: [["Action", "DescribeRegions"]],
      signedAt: SUITE_SIGNED_AT,
    });

    expect(headerNames(withoutToken.headers)).toEqual([
      "content-type",
      "x-amz-date",
      "authorization",
    ]);
    expect(authorizationOf(withoutToken.headers)).toContain(
      "SignedHeaders=content-type;host;x-amz-date,",
    );
    expect(headerNames(withToken.headers)).toEqual([
      "content-type",
      "x-amz-date",
      "authorization",
      "x-amz-security-token",
    ]);
    expect(authorizationOf(withToken.headers)).toContain(
      "SignedHeaders=content-type;host;x-amz-date;x-amz-security-token,",
    );
    expect(authorizationOf(withToken.headers)).not.toBe(
      authorizationOf(withoutToken.headers),
    );
  });

  it("percent-encodes the characters encodeURIComponent leaves alone", () => {
    expect(encodeAwsQueryComponent("a!b'c(d)e*f")).toBe("a%21b%27c%28d%29e%2Af");
    expect(encodeAwsQueryComponent("ubuntu/images/hvm-ssd-gp3/ubuntu-noble-*")).toBe(
      "ubuntu%2Fimages%2Fhvm-ssd-gp3%2Fubuntu-noble-%2A",
    );
    expect(encodeAwsQueryComponent("a+b=c d")).toBe("a%2Bb%3Dc%20d");
    expect(encodeAwsQueryComponent("keep-._~")).toBe("keep-._~");
  });

  it("keeps parameter order so indexed query-protocol members stay adjacent", () => {
    expect(encodeAwsQueryBody([
      ["Action", "RunInstances"],
      ["TagSpecification.1.Tag.1.Key", "blitz-workspace"],
      ["TagSpecification.1.Tag.1.Value", "ws/1"],
    ])).toBe(
      "Action=RunInstances&TagSpecification.1.Tag.1.Key=blitz-workspace"
        + "&TagSpecification.1.Tag.1.Value=ws%2F1",
    );
  });

  it("stamps dates in the basic ISO 8601 form SigV4 requires", () => {
    expect(amzDateStamp(SUITE_SIGNED_AT)).toBe("20150830T123600Z");
    expect(amzDateStamp(new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 678)))).toBe("20260102T030405Z");
  });

  it("changes the signature when any signed input changes", async () => {
    const base = {
      credentials: {
        accessKeyId: SUITE_ACCESS_KEY_ID,
        secretAccessKey: SUITE_SECRET_ACCESS_KEY,
      },
      region: "us-east-1",
      service: "ec2",
      host: SUITE_HOST,
      parameters: [["Action", "DescribeRegions"]] as const,
      signedAt: SUITE_SIGNED_AT,
    };
    const original = authorizationOf((await signAwsQueryRequest(base)).headers);

    expect(authorizationOf(
      (await signAwsQueryRequest({ ...base, region: "eu-west-1" })).headers,
    )).not.toBe(original);
    expect(authorizationOf(
      (await signAwsQueryRequest({ ...base, parameters: [["Action", "DescribeVolumes"]] })).headers,
    )).not.toBe(original);
    expect(authorizationOf(
      (await signAwsQueryRequest({
        ...base,
        signedAt: new Date(Date.UTC(2015, 7, 30, 12, 36, 1)),
      })).headers,
    )).not.toBe(original);
  });
});
