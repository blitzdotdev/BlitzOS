/**
 * PHASE 6 EXIT TEST 5 (plans/LODY-SHARING.md §7) — "the share/revoke UI works".
 *
 * Two halves, and only one of them is this dialog. The WAY IN is Lody's own row
 * context menu, reached through two props BlitzOS already had available
 * (`SessionListProps.sharing` + `onShareSessionWithTeam`), so the affordance
 * itself is pinned where the rail is drawn — `lody-session-rail.test.tsx`, which
 * needs a daemon. What is pinned here is the dialog: it reads the grants for one
 * session, it writes them, and it refuses read-write to a workspace viewer
 * before the server has to.
 *
 * Free, and gating every merge: the dialog talks to a client, and the client is
 * the thing under test's own seam.
 */
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ListSessionSharesResponse, SessionShareView, WorkspaceMemberView } from "@blitzos/schema";
import { SessionShareDialog } from "../src/SessionShareDialog.js";
import { render, settle } from "./dom.js";

const SESSION = "sess-alpha";

function member(overrides: Partial<WorkspaceMemberView> = {}): WorkspaceMemberView {
  return {
    membershipId: "membership-editor",
    name: "Grace Editor",
    avatarUrl: null,
    role: "member",
    machine: null,
    ...overrides,
  };
}

function share(overrides: Partial<SessionShareView> = {}): SessionShareView {
  return {
    id: "share-1",
    sessionId: SESSION,
    ownerMembershipId: "membership-owner",
    granteeMembershipId: "membership-editor",
    level: "ro",
    createdAt: 1_788_000_000_000,
    createdByMembershipId: "membership-owner",
    ...overrides,
  };
}

/** A stub that BEHAVES like the routes, because the dialog re-reads after every
 * write and a stub with a frozen answer would make the second click look like a
 * bug in the dialog. */
function client(granted: SessionShareView[]) {
  let rows = [...granted];
  return {
    listSessionShares: vi.fn(async (): Promise<ListSessionSharesResponse> => ({
      granted: [...rows],
      received: [],
    })),
    grantSessionShare: vi.fn(async (_workspaceId: string, input: { granteeMembershipId: string; level: "ro" | "rw" }) => {
      const created = share({ granteeMembershipId: input.granteeMembershipId, level: input.level });
      rows = [...rows.filter((row) => row.granteeMembershipId !== input.granteeMembershipId), created];
      return created;
    }),
    revokeSessionShare: vi.fn(async (_workspaceId: string, shareId: string) => {
      rows = rows.filter((row) => row.id !== shareId);
    }),
  };
}

function dialog(
  api: ReturnType<typeof client>,
  members: WorkspaceMemberView[],
  onClose = () => undefined,
) {
  return (
    <SessionShareDialog
      client={api}
      workspaceId="workspace-one"
      sessionId={SESSION}
      sessionTitle="fix the login redirect"
      members={members}
      viewerMembershipId="membership-owner"
      onClose={onClose}
    />
  );
}

function levelButton(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button.webapp-share-level")]
    .find((button) => button.textContent === label);
  if (found === undefined) throw new Error(`no level button labelled ${label}`);
  return found;
}

describe("the session share dialog", () => {
  it("shows every other member, with the grant they already hold", async () => {
    const api = client([share({ level: "rw" })]);
    const view = await render(dialog(api, [
      member(),
      member({ membershipId: "membership-owner", name: "Ada Owner", role: "admin" }),
    ]));
    await settle();

    // The caller is filtered out: "you cannot share with yourself" is a rule
    // this dialog states rather than a 400 the member discovers.
    expect(view.container.textContent).toContain("Grace Editor");
    expect(view.container.textContent).not.toContain("Ada Owner");
    expect(levelButton(view.container, "Read-write").getAttribute("aria-pressed")).toBe("true");
    expect(levelButton(view.container, "No access").getAttribute("aria-pressed")).toBe("false");
    await view.unmount();
  });

  it("grants, and re-reads the grants the server actually holds", async () => {
    const api = client([]);
    const view = await render(dialog(api, [member()]));
    await settle();

    await act(async () => levelButton(view.container, "Read-only").click());
    await settle();
    expect(api.grantSessionShare).toHaveBeenCalledWith("workspace-one", {
      sessionId: SESSION,
      granteeMembershipId: "membership-editor",
      level: "ro",
    });
    // The owner is not named: the rail lists the sessions on the caller's own
    // box, so the session is always theirs and the request omits it.
    expect(api.listSessionShares).toHaveBeenCalledTimes(2);
    await view.unmount();
  });

  it("revokes by id, and treats an already-revoked row as a no-op", async () => {
    const api = client([share()]);
    const view = await render(dialog(api, [member()]));
    await settle();

    await act(async () => levelButton(view.container, "No access").click());
    await settle();
    expect(api.revokeSessionShare).toHaveBeenCalledWith("workspace-one", "share-1");

    // Clicking it again asks the server for nothing: the row already reads
    // "No access", which is what the member asked for.
    api.revokeSessionShare.mockClear();
    await act(async () => levelButton(view.container, "No access").click());
    await settle();
    expect(api.revokeSessionShare).not.toHaveBeenCalled();
    await view.unmount();
  });

  it("will not offer read-write to a workspace viewer", async () => {
    const api = client([]);
    const view = await render(dialog(api, [member({ role: "viewer", name: "Wes Viewer" })]));
    await settle();

    // The server refuses it with a 400 either way (§1.2); disabling the control
    // is what stops the member finding that out by being told no.
    expect(levelButton(view.container, "Read-write").disabled).toBe(true);
    expect(levelButton(view.container, "Read-only").disabled).toBe(false);
    await view.unmount();
  });

  it("surfaces a refusal instead of pretending the grant landed", async () => {
    const api = client([]);
    api.grantSessionShare.mockRejectedValueOnce(new Error("that member is not in this workspace"));
    const view = await render(dialog(api, [member()]));
    await settle();

    await act(async () => levelButton(view.container, "Read-only").click());
    await settle();
    expect(view.container.querySelector("[role='alert']")?.textContent)
      .toBe("that member is not in this workspace");
    expect(levelButton(view.container, "No access").getAttribute("aria-pressed")).toBe("true");
    await view.unmount();
  });
});
