import { act, useEffect, useState } from "react";
import { Provider as JotaiProvider, atom, createStore, useAtomValue } from "jotai";
import {
  currentWorkspaceIdAtom,
  currentWorkspaceSlugAtom,
} from "@lody/components/atoms/workspace-context";
import { describe, expect, it, vi } from "vitest";
import {
  LodyRouteActivity,
  LodySurfaceVisibilityRoot,
} from "../src/lody/surface-activity.js";
import { seedLodySurfaceWorkspaceContext } from "../src/lody/surface-workspace-context.js";
import { render, settle } from "./dom.js";

const valueAtom = atom(0);

interface ProbeCounts {
  keydowns: number;
  atomChanges: number;
  effectMounts: number;
  effectCleanups: number;
}

type ProbeStore = ReturnType<typeof createStore>;

function EffectProbe(props: { store: ProbeStore; counts: ProbeCounts }) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    props.counts.effectMounts += 1;
    const onKeydown = (): void => {
      props.counts.keydowns += 1;
    };
    window.addEventListener("keydown", onKeydown);
    const unsubscribe = props.store.sub(valueAtom, () => {
      props.counts.atomChanges += 1;
    });
    return () => {
      props.counts.effectCleanups += 1;
      window.removeEventListener("keydown", onKeydown);
      unsubscribe();
    };
  }, [props.counts, props.store]);
  return (
    <div data-testid="scroll" style={{ overflow: "auto", height: 20 }}>
      <button type="button" onClick={() => setCount((value) => value + 1)}>
        state {count}
      </button>
    </div>
  );
}

describe("a hidden Lody route Activity", () => {
  it("reveals without scheduling a host measurement timer", async () => {
    const timer = vi.spyOn(globalThis, "setTimeout");
    const tree = (active: boolean) => (
      <LodyRouteActivity active={active}>
        <div>route</div>
      </LodyRouteActivity>
    );
    const view = await render(tree(false));
    const callsBeforeReveal = timer.mock.calls.length;
    await act(async () => view.root.render(tree(true)));
    expect(timer).toHaveBeenCalledTimes(callsBeforeReveal);
    await view.unmount();
    timer.mockRestore();
  });

  it("disconnects route effects while preserving DOM, state, and scroll position", async () => {
    const store = createStore();
    const counts: ProbeCounts = { keydowns: 0, atomChanges: 0, effectMounts: 0, effectCleanups: 0 };
    const tree = (active: boolean) => (
      <JotaiProvider store={store}>
        <LodyRouteActivity active={active}>
          <EffectProbe store={store} counts={counts} />
        </LodyRouteActivity>
      </JotaiProvider>
    );
    const view = await render(tree(true));
    const button = view.container.querySelector<HTMLButtonElement>("button");
    const scroll = view.container.querySelector<HTMLElement>("[data-testid='scroll']");
    if (button === null || scroll === null) throw new Error("probe did not mount");
    await act(async () => button.click());
    scroll.scrollTop = 73;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k" }));
    store.set(valueAtom, 1);
    expect(counts).toMatchObject({ keydowns: 1, atomChanges: 1, effectMounts: 1, effectCleanups: 0 });

    await act(async () => view.root.render(tree(false)));
    await settle();
    expect(counts.effectCleanups).toBe(1);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k" }));
    store.set(valueAtom, 2);
    expect(counts.keydowns).toBe(1);
    expect(counts.atomChanges).toBe(1);
    expect(view.container.querySelector("button")).toBe(button);
    expect(button.textContent).toBe("state 1");
    expect(scroll.scrollTop).toBe(73);

    await act(async () => view.root.render(tree(true)));
    await settle();
    expect(counts.effectMounts).toBe(2);
    expect(view.container.querySelector("button")).toBe(button);
    expect(button.textContent).toBe("state 1");
    expect(scroll.scrollTop).toBe(73);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k" }));
    store.set(valueAtom, 3);
    expect(counts.keydowns).toBe(2);
    expect(counts.atomChanges).toBe(2);
    await view.unmount();
  });

  it("keeps one workspace identity through Activity hide and clears it on eviction", async () => {
    const store = createStore();
    const runtimeCounts = { mounts: 0, cleanups: 0 };
    const release = seedLodySurfaceWorkspaceContext(store, {
      workspace: { slug: "local", workspaceId: "lw-one" },
    });
    function RuntimeProbe() {
      const slug = useAtomValue(currentWorkspaceSlugAtom);
      useEffect(() => {
        if (slug === null) return undefined;
        runtimeCounts.mounts += 1;
        return () => {
          runtimeCounts.cleanups += 1;
        };
      }, [slug]);
      return null;
    }
    const tree = (active: boolean) => (
      <JotaiProvider store={store}>
        <RuntimeProbe />
        <LodyRouteActivity active={active}><div>route</div></LodyRouteActivity>
      </JotaiProvider>
    );
    const view = await render(tree(true));
    await act(async () => view.root.render(tree(false)));
    await settle();
    expect(store.get(currentWorkspaceSlugAtom)).toBe("local");
    expect(store.get(currentWorkspaceIdAtom)).toBe("lw-one");
    expect(runtimeCounts).toEqual({ mounts: 1, cleanups: 0 });

    release();
    expect(store.get(currentWorkspaceSlugAtom)).toBeNull();
    expect(store.get(currentWorkspaceIdAtom)).toBeNull();
    await view.unmount();
  });
});

describe("retained Lody surface focus", () => {
  it("reapplies a captured conversation offset after the reveal commit", async () => {
    const tree = (hidden: boolean) => (
      <LodySurfaceVisibilityRoot hidden={hidden} className="surface">
        <div className="chat-scrollbar" style={{ overflowY: "auto", height: 20 }}>
          conversation
        </div>
      </LodySurfaceVisibilityRoot>
    );
    const view = await render(tree(false));
    const scroller = view.container.querySelector<HTMLElement>(".chat-scrollbar");
    if (scroller === null) throw new Error("conversation scroller did not mount");
    scroller.scrollTop = 73;

    await act(async () => view.root.render(tree(true)));
    // Model the clamp/reflow that jsdom itself cannot perform for display:none.
    scroller.scrollTop = 0;
    await act(async () => view.root.render(tree(false)));
    expect(scroller.scrollTop).toBe(73);
    await view.unmount();
  });

  it("reapplies a semantic offset to a replacement conversation scroller", async () => {
    const tree = (hidden: boolean, replacement: boolean) => (
      <LodySurfaceVisibilityRoot hidden={hidden} className="surface">
        <div
          key={replacement ? "replacement" : "original"}
          className="chat-scrollbar"
          style={{ overflowY: "auto", height: 20 }}
        >
          conversation
        </div>
      </LodySurfaceVisibilityRoot>
    );
    const view = await render(tree(false, false));
    const original = view.container.querySelector<HTMLElement>(".chat-scrollbar");
    if (original === null) throw new Error("conversation scroller did not mount");
    original.scrollTop = 73;

    await act(async () => view.root.render(tree(true, false)));
    await act(async () => view.root.render(tree(true, true)));
    const replacement = view.container.querySelector<HTMLElement>(".chat-scrollbar");
    if (replacement === null) throw new Error("replacement scroller did not mount");
    expect(replacement).not.toBe(original);
    replacement.scrollTop = 0;
    await act(async () => view.root.render(tree(false, true)));
    expect(replacement.scrollTop).toBe(73);
    await view.unmount();
  });

  it("restores the last focused element, then falls back to the composer", async () => {
    const tree = (hidden: boolean, original = true) => (
      <LodySurfaceVisibilityRoot hidden={hidden} className="surface">
        {original && <input aria-label="original" />}
        <textarea aria-label="composer" />
      </LodySurfaceVisibilityRoot>
    );
    const view = await render(tree(false));
    const original = view.container.querySelector<HTMLInputElement>("[aria-label='original']");
    if (original === null) throw new Error("focus probe did not mount");
    original.focus();
    expect(document.activeElement).toBe(original);

    await act(async () => view.root.render(tree(true)));
    await act(async () => view.root.render(tree(false)));
    await settle();
    expect(document.activeElement).toBe(original);

    await act(async () => view.root.render(tree(true, false)));
    await act(async () => view.root.render(tree(false, false)));
    await settle();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("composer");
    await view.unmount();
  });
});
