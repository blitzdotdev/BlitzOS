/**
 * Seam patch 19, the shell's half of the state report (`useSidePanelHostState`).
 *
 * The surface reports the panel whenever any input of it changes, the host
 * tabs included, and the report is a fresh object every time. Held naively,
 * a report re-renders the shell, the shell rebuilds its binding, the surface
 * re-renders under it and — if the tab list was built from anything that is
 * not referentially stable across a render — reports again, until React
 * throws "Maximum update depth exceeded" (#185). That is what a session on
 * `/workspaces/:id/chat` did. The hook drops a report equal to what the shell
 * already holds, and this pins that a shell that rebuilds `hostTabs` on every
 * render still settles, while a real change still lands.
 */
import { useEffect, useMemo } from "react";
import { act } from "react";
import { describe, expect, it } from "vitest";
import {
  sidePanelStatesEqual,
  useSidePanelHostState,
  type SessionHostSidePanelTab,
  type SessionSidePanelHostState,
} from "../src/lody/side-panel.js";
import { render, settle } from "./dom.js";

/** The seam's report effect in miniature: the options are memoized on the
 * host tabs' IDENTITY, and every change of them is one report. */
function Surface(props: {
  hostTabs: readonly SessionHostSidePanelTab[];
  open: boolean;
  onStateChange: (state: SessionSidePanelHostState) => void;
}) {
  const { hostTabs, open, onStateChange } = props;
  const availableOptions = useMemo(
    () => hostTabs.map((tab) => ({ id: tab.id, disabled: false })),
    [hostTabs],
  );
  useEffect(() => {
    onStateChange({ open, activeTabId: null, openedTabIds: [], availableOptions });
  }, [availableOptions, onStateChange, open]);
  return null;
}

/** A shell whose tab list is rebuilt on every render, as one built from a
 * handler declared in the render body is. */
function Shell(props: { renders: { count: number }; open: boolean }) {
  const [state, onStateChange] = useSidePanelHostState();
  props.renders.count += 1;
  const hostTabs: SessionHostSidePanelTab[] = [
    { id: "host:connections", label: "Connections", content: null },
  ];
  return (
    <>
      <Surface hostTabs={hostTabs} open={props.open} onStateChange={onStateChange} />
      <output>{state === null ? "none" : `${state.open}:${state.availableOptions.map((o) => o.id).join(",")}`}</output>
    </>
  );
}

describe("useSidePanelHostState", () => {
  it("settles when the shell rebuilds its host tabs on every render", async () => {
    const renders = { count: 0 };
    const view = await render(<Shell renders={renders} open={false} />);
    await settle();
    expect(view.container.querySelector("output")?.textContent).toBe("false:host:connections");
    // One render to mount, one for the first report, and one more where React
    // re-invokes the shell for the equal report and bails out of its children.
    expect(renders.count, `renders: ${renders.count}`).toBeLessThanOrEqual(3);
    await view.unmount();
  });

  it("still takes a report that differs", async () => {
    const renders = { count: 0 };
    const view = await render(<Shell renders={renders} open={false} />);
    await settle();
    await act(async () => view.root.render(<Shell renders={renders} open={true} />));
    await settle();
    expect(view.container.querySelector("output")?.textContent).toBe("true:host:connections");
    expect(renders.count, `renders: ${renders.count}`).toBeLessThanOrEqual(6);
    await view.unmount();
  });
});

describe("sidePanelStatesEqual", () => {
  const base: SessionSidePanelHostState = {
    open: true,
    activeTabId: "files",
    openedTabIds: ["files", "host:connections"],
    availableOptions: [
      { id: "side-session", disabled: true },
      { id: "files", disabled: false },
    ],
  };
  it("is field-wise, not by identity", () => {
    expect(sidePanelStatesEqual(base, { ...base, openedTabIds: [...base.openedTabIds] })).toBe(true);
    expect(sidePanelStatesEqual(null, null)).toBe(true);
    expect(sidePanelStatesEqual(base, null)).toBe(false);
  });
  it("sees every field", () => {
    expect(sidePanelStatesEqual(base, { ...base, open: false })).toBe(false);
    expect(sidePanelStatesEqual(base, { ...base, activeTabId: null })).toBe(false);
    expect(sidePanelStatesEqual(base, { ...base, openedTabIds: ["files"] })).toBe(false);
    expect(
      sidePanelStatesEqual(base, {
        ...base,
        availableOptions: [{ id: "side-session", disabled: false }, { id: "files", disabled: false }],
      }),
    ).toBe(false);
  });
});
