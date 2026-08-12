import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { ErrorState } from "../src/components/RetryActionButton.js";
import { render } from "./dom.js";

describe("retry rendering", () => {
  it("varies only retryAction while error copy stays constant", async () => {
    const retry = vi.fn();
    const view = await render(<ErrorState error="same failure" retryAction={null} onRetry={retry} />);
    expect(view.container.textContent).toContain("same failure");
    expect(view.container.querySelector("[data-retry-action]")).toBeNull();

    await act(async () => view.root.render(<ErrorState error="same failure" retryAction="poll" onRetry={retry} />));
    const button = view.container.querySelector<HTMLButtonElement>('[data-retry-action="poll"]');
    expect(view.container.textContent).toContain("same failure");
    expect(button).not.toBeNull();
    await act(async () => button?.click());
    expect(retry).toHaveBeenCalledWith("poll");
    await view.unmount();
  });
});
