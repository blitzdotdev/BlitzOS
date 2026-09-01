/**
 * "Is this the chat landing, or a blank pane?" — asked without pinning the
 * headline to one string.
 *
 * The vendored landing does not have A headline. It rotates between two, once
 * per UTC day (`vendor/lody/packages/components/src/components/chat/chat-landing.tsx:4344`):
 *
 *     const headings = [t('chat.heading'), t('chat.heading2')];
 *     const title = headings[Math.floor(getServerNow() / 86_400_000) % headings.length];
 *
 * So a test that looks for `chat.heading` alone passes on even days and fails
 * on odd ones. That is the whole flake: nothing about the shell changed, the
 * calendar did.
 *
 * BOTH STRINGS ARE READ FROM THE VENDORED LOCALE, not copied out of it. The
 * component resolves them through i18next against this same file
 * (`src/lody/i18n.ts` loads it as the `en` translation resource), so a merge
 * that rewords either heading moves the assertion with it. Copying the text
 * here would put the flake back one merge later, silently.
 *
 * A key that upstream DELETES is a type error at this import, which is the
 * loud failure we want: the landing's headline would then be something this
 * helper does not know about.
 */
import { expect } from "vitest";
import en from "../../../vendor/lody/locales/en.json";

/** Every headline the landing may draw today. Order matches the component's. */
const LANDING_HEADINGS: readonly string[] = [en["chat.heading"], en["chat.heading2"]];

/**
 * Assert that `text` — a container's or an element's `textContent` — carries
 * one of the landing's headlines, whichever the day selected.
 *
 * @param text rendered text; `null`/`undefined` reads as empty, so a missing
 *   element fails here rather than passing by accident.
 * @param because what the caller is really claiming, quoted back on failure.
 */
export function expectLandingHeading(text: string | null | undefined, because: string): void {
  const rendered = text ?? "";
  const drawn = LANDING_HEADINGS.filter((heading) => rendered.includes(heading));
  expect(
    drawn,
    `${because} — the rendered text carries none of ${JSON.stringify(LANDING_HEADINGS)}`,
  ).not.toHaveLength(0);
}
