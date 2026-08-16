import { describe, expect, it } from "vitest";
import { WorkspaceWebAppAuth } from "../core/webapp-tickets.js";

describe("workspace webApp tickets", () => {
  it("signs and verifies short-lived identity claims", async () => {
    const auth = new WorkspaceWebAppAuth("ticket-root-secret");
    const ticket = await auth.mint({
      workspaceId: "workspace-one",
      userId: "user-one",
      membershipId: "membership-one",
      role: "viewer",
      surface: "terminal",
    }, 1_000);
    await expect(auth.verify(ticket, "workspace-one", "terminal", 1_059)).resolves.toEqual({
      kind: "ticket",
      claims: {
        workspaceId: "workspace-one",
        userId: "user-one",
        membershipId: "membership-one",
        role: "viewer",
        surface: "terminal",
        exp: 1_060,
      },
    });
    await expect(auth.verify(ticket, "workspace-one", "terminal", 1_060)).resolves.toBeNull();
    await expect(auth.verify(ticket, "workspace-two", "terminal", 1_000)).resolves.toBeNull();
    await expect(auth.verify(ticket, "workspace-one", "files", 1_000)).resolves.toBeNull();
    await expect(auth.verify(`${ticket.slice(0, -1)}x`, "workspace-one", "terminal", 1_000)).resolves.toBeNull();
  });

  it("accepts the static workspace token as the owner-equivalent compatibility path", async () => {
    const auth = new WorkspaceWebAppAuth("ticket-root-secret");
    const token = await auth.tokenFor("workspace-one");
    await expect(auth.verify(token, "workspace-one", "chat", 1_000)).resolves.toEqual({
      kind: "static",
      claims: expect.objectContaining({
        workspaceId: "workspace-one",
        userId: "legacy-owner",
        membershipId: "legacy-owner",
        role: "owner",
        surface: "chat",
      }),
    });
    await expect(auth.verify(`${token}x`, "workspace-one", "chat", 1_000)).resolves.toBeNull();
  });
});
