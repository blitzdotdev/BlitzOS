import type { WebAppSessionType } from '../SessionTypeIcon';

/** One managed tab, as the rail draws it. Build 2 swaps the feed for real
 * session rows; the shape the rail consumes is meant to survive that. */
export type RailSession = {
  id: string;
  label: string;
  agent: WebAppSessionType;
};
