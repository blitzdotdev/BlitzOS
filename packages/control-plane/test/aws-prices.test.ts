import { describe, expect, it } from "vitest";
import {
  AWS_PRICE_SNAPSHOT_EXPIRES_AT_MS,
  awsMonthlyPrice,
} from "../core/compute/aws-prices.js";
import { awsProviderFromEnv } from "../core/compute/aws.js";

const IN_DATE_MS = Date.UTC(2026, 7, 25, 12, 0, 0);

function provider(region: string, nowMs: number) {
  const aws = awsProviderFromEnv(
    {
      AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_REGION: region,
      AWS_IMAGE_ID: "ami-0123456789abcdef0",
    },
    { now: () => nowMs },
  );
  if (aws === undefined) throw new Error("expected a configured AWS provider");
  return aws;
}

describe("AWS machine prices", () => {
  it("gives every offered machine a price in a snapshotted region", async () => {
    const machineTypes = await provider("us-east-1", IN_DATE_MS).listMachineTypes();

    // 730 instance hours plus the gp3 root volume, because Hetzner's figure
    // includes its disk and the two cards sit in one grid.
    expect(machineTypes.map(({ id, monthlyPrice }) => ({ id, monthlyPrice }))).toEqual([
      { id: "aws-t3.medium@us-east-1", monthlyPrice: { amount: 33.57, currency: "USD" } },
      { id: "aws-t3.large@us-east-1", monthlyPrice: { amount: 65.54, currency: "USD" } },
      { id: "aws-m6i.large@us-east-1", monthlyPrice: { amount: 74.88, currency: "USD" } },
      { id: "aws-m6i.xlarge@us-east-1", monthlyPrice: { amount: 146.56, currency: "USD" } },
    ]);
  });

  it("prices Ireland from Ireland's own rates, not Virginia's", async () => {
    const machineTypes = await provider("eu-west-1", IN_DATE_MS).listMachineTypes();

    expect(machineTypes[0]?.monthlyPrice).toEqual({ amount: 36.81, currency: "USD" });
  });

  it("shows no price for a region the snapshot never read", async () => {
    const machineTypes = await provider("ap-south-1", IN_DATE_MS).listMachineTypes();

    expect(machineTypes.map(({ id }) => id)).toEqual([
      "aws-t3.medium@ap-south-1",
      "aws-t3.large@ap-south-1",
      "aws-m6i.large@ap-south-1",
      "aws-m6i.xlarge@ap-south-1",
    ]);
    expect(machineTypes.every(({ monthlyPrice }) => monthlyPrice === null)).toBe(true);
  });

  it("stops publishing the snapshot once it is past its shelf life", async () => {
    // A copied price rots. A rotten price lies about money, the same way the
    // euro sign did. So the card goes blank rather than stale.
    const stale = await provider("us-east-1", AWS_PRICE_SNAPSHOT_EXPIRES_AT_MS)
      .listMachineTypes();

    expect(stale.every(({ monthlyPrice }) => monthlyPrice === null)).toBe(true);
    expect(
      awsMonthlyPrice("us-east-1", "t3.medium", 40, AWS_PRICE_SNAPSHOT_EXPIRES_AT_MS - 1),
    ).toEqual({ amount: 33.57, currency: "USD" });
  });

  it("keeps the snapshot fresh", () => {
    // This is the staleness alarm. When it fails, re-read the AWS Price List
    // Bulk API, update REGION_PRICES and CAPTURED_ON in
    // core/compute/aws-prices.ts, and land both together. Until then every
    // AWS card shows no price.
    expect(Date.now()).toBeLessThan(AWS_PRICE_SNAPSHOT_EXPIRES_AT_MS);
  });
});
