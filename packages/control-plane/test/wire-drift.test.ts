import * as schema from "@blitzos/schema";
import { describe, expect, it } from "vitest";
import * as wire from "../core/wire.js";

const workspace: wire.WorkspaceView & schema.WorkspaceView = {
  id: "workspace",
  machineTypeId: "mv-2c2g@lab",
  phase: "ready",
  retryAction: null,
  canObserve: true,
  launchable: true,
  revision: 3,
  ssh: {
    host: "203.0.113.10",
    port: 22,
    user: "blitz",
    hostPublicKey: "ssh-ed25519 AAAAhost",
  },
  volumeId: "volume",
  error: null,
};

const feed: wire.FeedResponse & schema.FeedResponse = {
  version: "version",
  members: [
    {
      unixName: "operator",
      harnesses: ["claude", "codex"],
      keys: [{ pubkey: "ssh-ed25519 AAAAkey", op: "mint" }],
    },
  ],
};

describe("local wire copies", () => {
  it("keeps constants and representative JSON shapes equal to @blitzos/schema", () => {
    expect(wire.FEED_MAX_BYTES).toBe(schema.FEED_MAX_BYTES);
    expect(wire.HARNESSES).toEqual(schema.HARNESSES);
    expect(wire.PHASES).toEqual(schema.PHASES);
    expect(wire.RETRY_ACTIONS).toEqual(schema.RETRY_ACTIONS);
    expect(wire.PHASE_TRANSITIONS).toEqual(schema.PHASE_TRANSITIONS);
    expect(JSON.parse(JSON.stringify(workspace))).toEqual(workspace);
    expect(JSON.parse(JSON.stringify(feed))).toEqual(feed);
  });
});
