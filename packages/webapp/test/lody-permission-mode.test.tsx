/**
 * Selecting "Manual" — the phase-3 blocker, closed
 * (plans/LODY-RUNTIME-DESIGN.md §8.6).
 *
 * WHY IT MATTERS. `BUILTIN_DEFAULT_MODE_IDS.claude` is `'auto'`
 * (`vendor/lody/packages/shared/src/ai.ts:402`), a mode whose classifier answers
 * permission prompts on the member's behalf. The permission-request card
 * therefore never appears unless the classifier escalates, so the phase-3 exit
 * test could not reach it — and the product answer is to pick `default`
 * ("Manual") from the composer first. §8.6 recorded that "driving that selector
 * through a Radix submenu in jsdom was not solved here".
 *
 * WHAT IT ACTUALLY IS. Not a submenu: `DesktopPermissionModeButton`
 * (`components/sessions/desktop-run-config-menu.tsx:1014`) is a FLAT
 * `DropdownMenu` with its own trigger, `aria-label="Permission"`. It is
 * separate from the run-configuration menu on purpose — their comment at `:73`
 * says permission is "the knob users flip most". So it is driven exactly the
 * way the phase-3 test already drives the run-configuration trigger, and this
 * pins that at the component boundary, where it costs no daemon and no turn.
 *
 * THE OPTIONS ARE REAL. `auto`/"Auto" and `default`/"Manual" are what
 * `machine/acp-capabilities-refresh` reported for `blitz-claude` against a real
 * `lody@0.88.1` daemon and `/usr/local/bin/claude`, measured while closing this
 * blocker. A fixture rather than a live refresh because what is under test is
 * the CONTROL, and the refresh is already pinned by
 * `lody-session-surface.test.tsx`.
 */
import { act } from "react";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it, vi } from "vitest";
import { DesktopPermissionModeButton } from "@lody/components/components/sessions/desktop-run-config-menu";
import { initLodyI18n } from "../src/lody/i18n.js";
import { render, settle } from "./dom.js";

/** Verbatim from the daemon's `acp-capabilities-refresh_response` for the
 * `blitz-claude` config. */
const CLAUDE_MODES = [
  {
    value: "auto",
    label: "Auto",
    description: "Use a model classifier to approve/deny permission prompts",
  },
  { value: "default", label: "Manual", description: "Standard behavior, prompts for dangerous actions" },
];

/** Radix triggers act on `pointerdown`, which jsdom does not synthesize from
 * `click()`. The same three events the phase-3 exit test uses. */
function openMenu(trigger: HTMLElement): void {
  trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
  trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  trigger.click();
}

function menuItems(): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>("[role='menuitem']")];
}

describe("the composer's permission-mode selector", () => {
  it("opens, offers Auto and Manual, and reports the Manual mode id", async () => {
    const onModeChange = vi.fn();
    const i18n = initLodyI18n();
    const view = await render(
      <I18nextProvider i18n={i18n}>
        <DesktopPermissionModeButton
          modeOptions={CLAUDE_MODES}
          selectedModeId="auto"
          onModeChange={onModeChange}
        />
      </I18nextProvider>,
    );

    const trigger = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Permission"]',
    );
    expect(trigger).not.toBeNull();
    // The face shows the CURRENT mode, which is the classifier one — that is
    // the whole reason the card never appears by default.
    expect(trigger?.textContent).toContain("Auto");

    await act(async () => {
      openMenu(trigger as HTMLButtonElement);
    });
    await settle();

    const labels = menuItems().map((item) => item.textContent ?? "");
    expect(labels.some((label) => label.includes("Auto"))).toBe(true);
    const manual = menuItems().find((item) => item.textContent?.includes("Manual"));
    expect(manual, `menu offered: ${labels.join(" | ")}`).toBeDefined();

    await act(async () => {
      (manual as HTMLElement).click();
    });
    await settle();
    // `'default'` is the mode id, "Manual" is only its name. Passing the label
    // through would be accepted by nothing on the daemon side.
    expect(onModeChange).toHaveBeenCalledWith("default");
    await view.unmount();
  });

  it("renders nothing at all when the capabilities pass has produced no modes", async () => {
    // The other half of the phase-3 finding: with no `acpCapability` rows the
    // control does not exist, so a test that looked for it would report
    // "undrivable" when the real problem is upstream at
    // `LODY-RUNTIME-DESIGN.md` §8.3.
    const i18n = initLodyI18n();
    const view = await render(
      <I18nextProvider i18n={i18n}>
        <DesktopPermissionModeButton modeOptions={[]} selectedModeId={null} />
      </I18nextProvider>,
    );
    expect(view.container.querySelector('button[aria-label="Permission"]')).toBeNull();
    await view.unmount();
  });
});
