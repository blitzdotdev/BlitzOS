import type { MachinePrice } from "../wire.js";

/**
 * A hand-copied snapshot of AWS list prices, for the AWS adapter alone.
 *
 * The EC2 API this adapter speaks states no price. The AWS Pricing API is a
 * second service with its own credentials and its own client, which is more
 * machinery than one card label is worth. So the numbers below are copied.
 *
 * Source: AWS Price List Bulk API, offer file AmazonEC2, offer version
 * 20260824193147, published 2026-08-24. Rows read: on-demand, Linux, shared
 * tenancy, no pre-installed software, no license; and gp3 provisioned
 * storage. Every source row states USD in its Currency column.
 * Read on 2026-08-25 from
 * https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/20260824193147/<region>/index.csv
 *
 * A snapshot rots. A rotten price lies about money, exactly like the euro
 * sign that this change removed from dollar amounts. So the snapshot expires:
 * past the shelf life the adapter shows no price at all, and the freshness
 * test in `test/aws-prices.test.ts` fails and names this file. A customer
 * then sees a blank corner instead of a stale number, and the team sees red
 * CI instead of nothing.
 */
const CAPTURED_ON = "2026-08-25";

/** Six months. AWS changes on-demand list prices rarely, so a shorter window
 * only makes noise. A longer one lets a price drift for most of a year. */
const SHELF_LIFE_DAYS = 180;

const DAY_MS = 24 * 60 * 60 * 1_000;

/** The instant the snapshot stops being publishable. Exported so the
 * freshness test names the same date the adapter uses. */
export const AWS_PRICE_SNAPSHOT_EXPIRES_AT_MS =
  Date.parse(`${CAPTURED_ON}T00:00:00Z`) + SHELF_LIFE_DAYS * DAY_MS;

/** AWS bills instances by the hour. Its own calculator states a month as 730
 * hours, so the card uses the same number. */
const HOURS_PER_MONTH = 730;

interface AwsInstanceHourPrice {
  readonly instanceType: string;
  /** On-demand Linux list price for one instance hour. */
  readonly hour: number;
}

interface AwsRegionPrices {
  readonly region: string;
  /** ISO 4217, copied from the Currency column of the source rows. */
  readonly currency: string;
  /** gp3 provisioned storage, per GB for one month. The adapter asks for a
   * gp3 root volume, and AWS bills it apart from the instance. Hetzner
   * includes its disk in one figure, so the AWS card adds the disk back.
   * Otherwise the two providers' cards are not comparable. */
  readonly gp3GbMonth: number;
  readonly instances: readonly AwsInstanceHourPrice[];
}

/** Only the regions read from the source. An unlisted region gets no price:
 * one region's prices are not another's, and guessing repeats the defect. */
const REGION_PRICES: readonly AwsRegionPrices[] = [
  {
    region: "us-east-1",
    currency: "USD",
    gp3GbMonth: 0.08,
    instances: [
      { instanceType: "t3.medium", hour: 0.0416 },
      { instanceType: "t3.large", hour: 0.0832 },
      { instanceType: "m6i.large", hour: 0.096 },
      { instanceType: "m6i.xlarge", hour: 0.192 },
    ],
  },
  {
    region: "eu-west-1",
    currency: "USD",
    gp3GbMonth: 0.088,
    instances: [
      { instanceType: "t3.medium", hour: 0.0456 },
      { instanceType: "t3.large", hour: 0.0912 },
      { instanceType: "m6i.large", hour: 0.107 },
      { instanceType: "m6i.xlarge", hour: 0.214 },
    ],
  },
];

/**
 * The monthly price of one AWS machine, or null when the snapshot cannot
 * answer. It cannot answer in three cases: the snapshot is past its shelf
 * life, the region is not in it, or the instance type is not in it. All three
 * show no price. None of them guesses.
 */
export function awsMonthlyPrice(
  region: string,
  instanceType: string,
  diskGb: number,
  nowMs: number,
): MachinePrice | null {
  if (nowMs >= AWS_PRICE_SNAPSHOT_EXPIRES_AT_MS) return null;
  const regionPrices = REGION_PRICES.find((entry) => entry.region === region);
  if (regionPrices === undefined) return null;
  const instance = regionPrices.instances.find(
    (entry) => entry.instanceType === instanceType,
  );
  if (instance === undefined) return null;
  const amount = instance.hour * HOURS_PER_MONTH + regionPrices.gp3GbMonth * diskGb;
  // Money on a card reads in whole cents. Float arithmetic does not.
  return { amount: Math.round(amount * 100) / 100, currency: regionPrices.currency };
}
