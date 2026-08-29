import { expect, test } from '@playwright/test';

test('provider-side preparsed large diff remains responsive while scrolling', async ({ page }) => {
  test.setTimeout(60_000);

  const response = await page.goto(
    '/iframe.html?id=ui-diffviewer--provider-side-preparsed-large-diff&viewMode=story'
  );
  expect(response?.ok()).toBeTruthy();

  const diff = page.locator('diffs-container');
  await expect(diff).toBeVisible({ timeout: 30_000 });

  const lag = await page.evaluate(async () => {
    const scrollParent = document.querySelector<HTMLElement>('.scrollbar-pro');
    if (!scrollParent) {
      throw new Error('diff scroll parent not found');
    }

    const samples: number[] = [];
    let lastTick = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      samples.push(now - lastTick);
      lastTick = now;
    }, 16);

    for (let index = 0; index < 24; index += 1) {
      scrollParent.scrollTop = index * 240;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 200));
    window.clearInterval(timer);

    return {
      maxMs: Math.max(...samples),
      sampleCount: samples.length,
    };
  });

  expect(lag.sampleCount).toBeGreaterThan(5);
  expect(lag.maxMs).toBeLessThan(250);
});
