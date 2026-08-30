import { expect, test, type Locator, type Page } from '@playwright/test';

const STORY_URL = '/iframe.html?id=mobile-mobileswipeablerow--grouped&viewMode=story';

test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 393, height: 852 },
});

async function swipeLeft(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error('Swipe target is not visible');

  const session = await page.context().newCDPSession(page);
  const y = box.y + box.height / 2;
  const startX = box.x + box.width * 0.75;

  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: startX, y }],
  });
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: startX - 80, y }],
  });
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: startX - 150, y }],
  });
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await session.detach();
}

test('revealed archive action removes the swiped row when tapped', async ({ page }) => {
  await page.goto(STORY_URL);

  const rowTitle = page.getByText('重构评估 UI', { exact: true });
  await expect(rowTitle).toBeVisible();

  await swipeLeft(page, rowTitle);

  const archiveButton = page.getByRole('button', { name: 'Archive' });
  await expect(archiveButton).toBeVisible();
  await archiveButton.tap();

  await expect(rowTitle).toHaveCount(0);
});
