import { expect, test } from '@playwright/test';

/**
 * Not a test — records a video walkthrough of the real app running the demo,
 * for the README demo GIF / "how it works" clip. Run:
 *   npx playwright test walkthrough.spec.ts
 * The .webm lands under test-results/; convert to GIF with ffmpeg.
 */

test.use({
  viewport: { width: 1440, height: 900 },
  video: { mode: 'on', size: { width: 1440, height: 900 } },
});

// Asset generator, not part of the CI suite. It assumes a fresh, empty bridge
// (records the demo GIF from the empty state onward); in CI the bridge is
// shared across parallel test files, so the empty state is already gone. Run
// it locally (CI unset) to regenerate the walkthrough video.
test.beforeEach(() => {
  test.skip(!!process.env.CI, 'asset generator — run locally, not in CI');
});

test('walkthrough: a workflow comes to life', async ({ page, request }) => {
  await page.goto('/');
  // Empty state — the two front doors.
  await expect(page.getByRole('button', { name: /run the demo/i })).toBeVisible();
  await page.waitForTimeout(1200);

  // Start the scripted 7-agent story at a watchable pace.
  const res = await request.post('/demo/start', { data: { speed: 4 } });
  const { sessionId } = (await res.json()) as { sessionId: string };
  await page.getByRole('combobox', { name: 'Session' }).selectOption(`live:${sessionId}`);

  // Agents bloom and connect; parallel coders appear together.
  await expect(page.getByRole('group', { name: /^Coder A/ })).toBeVisible();
  await expect(page.getByRole('group', { name: /^Coder B/ })).toBeVisible();
  await page.waitForTimeout(3500); // watch them work in parallel

  // Peek into focus mode to show the live terminal for one coder.
  await page.getByRole('group', { name: /^Coder A/ }).dblclick();
  await page.waitForTimeout(2600);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);

  // Ride it out to completion (reviewer approval flashes through the rail).
  await expect(page.getByRole('group', { name: /^Tester.*Done/i })).toBeVisible({
    timeout: 40_000,
  });
  await page.waitForTimeout(1600);

  // A moment in light mode to show it's theme-aware.
  await page.getByRole('button', { name: /toggle theme/i }).click();
  await page.waitForTimeout(1800);
});
