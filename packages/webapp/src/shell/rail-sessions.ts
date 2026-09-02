import type { WebAppSessionType } from '../WebAppHeader';

/** One managed tab, as the rail draws it. Build 2 swaps the feed for real
 * session rows; the shape the rail consumes is meant to survive that. */
export type DriveRailSession = {
  id: string;
  label: string;
  agent: WebAppSessionType;
};
