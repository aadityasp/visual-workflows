import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';

/**
 * End-to-end against the production-shaped stack: the bridge serving the
 * built UI, real WebSocket streaming, the real reducer, and the real canvas.
 *
 * Locators go through the accessible contract, not raw text:
 *  - agent panels are role=group named "<name>[, <type>]: <status>[ (minimized)]"
 *    (plain getByText would also match hidden <option>s in the session picker).
 *  - completed agents show the status label "Done" (canvas/status.ts) and
 *    auto-minimize, so a finished Tester reads "Tester: Done (minimized)".
 *
 * Tests share one bridge, so each selects its OWN session explicitly (the
 * /demo/start response and the ingest sessionId are known) rather than
 * relying on auto-select. Transient states are asserted deterministically by
 * ingesting a crafted event through the real /ingest path.
 */

const DATA_DIR = process.env.VW_DATA_DIR ?? '/tmp/vw-e2e-data';
const readToken = () => fs.readFileSync(path.join(DATA_DIR, 'token'), 'utf8').trim();
const panel = (page: Page, name: RegExp) => page.getByRole('group', { name });

async function startDemo(request: APIRequestContext, page: Page, speed: number): Promise<string> {
  const res = await request.post('/demo/start', { data: { speed } });
  expect(res.ok()).toBeTruthy();
  const { sessionId } = (await res.json()) as { sessionId: string };
  await page.getByRole('combobox', { name: 'Session' }).selectOption(`live:${sessionId}`);
  return sessionId;
}

test('empty state offers the demo and connect actions', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/visual-workflows/i);
  await expect(page.getByRole('button', { name: /run the demo/i })).toBeVisible();
  await expect(page.getByText(/connect claude code/i).first()).toBeVisible();
});

test('demo run: session appears, agents work in parallel, everything completes', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await startDemo(request, page, 25);

  // Simulated data is always labeled.
  await expect(page.getByRole('banner').getByText('Demo', { exact: true })).toBeVisible();

  // The parallel coders prove concurrent panels exist at once.
  await expect(panel(page, /^Coder A/)).toBeVisible();
  await expect(panel(page, /^Coder B/)).toBeVisible();
  await expect(panel(page, /^Planner/)).toBeVisible();
  await expect(panel(page, /^Tester/)).toBeVisible();

  // At speed 25 the whole story lands in seconds; the end state is stable.
  await expect(panel(page, /^Tester.*Done/i)).toBeVisible({ timeout: 30_000 });
  await expect(panel(page, /^Planner.*Done/i)).toBeVisible({ timeout: 30_000 });
});

test('status is exposed as text in the accessible name, never color alone', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await startDemo(request, page, 25);
  // Every panel carries a textual status in its accessible name; the stable
  // completed state ("Done") proves the icon+text contract.
  await expect(page.getByRole('group', { name: /: Done/i }).first()).toBeVisible({
    timeout: 30_000,
  });
});

test('an approval request surfaces in the attention rail', async ({ page, request }) => {
  await page.goto('/');
  const token = readToken();
  const sessionId = `e2e-approval-${Date.now()}`;
  const now = () => new Date().toISOString();
  const events = [
    { ts: now(), source: 'manual', sessionId, type: 'session_started', payload: { title: 'E2E' } },
    {
      ts: now(),
      source: 'manual',
      sessionId,
      agentId: 'reviewer',
      type: 'agent_created',
      payload: { name: 'Reviewer', kind: 'subagent', agentType: 'reviewer' },
    },
    {
      ts: now(),
      source: 'manual',
      sessionId,
      agentId: 'reviewer',
      type: 'approval_requested',
      payload: {
        requestId: 'req-e2e-1',
        kind: 'question',
        prompt: 'Reviewer flags: ThemeProvider drops user preference on reload. Apply the fix?',
      },
    },
  ];
  const res = await request.post('/ingest', {
    headers: { 'x-vw-token': token, 'content-type': 'application/json' },
    data: events,
  });
  expect(res.ok()).toBeTruthy();

  await page.getByRole('combobox', { name: 'Session' }).selectOption(`live:${sessionId}`);

  // The unresolved approval persists in state, so the rail shows it stably.
  await expect(page.getByText(/needs attention/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/reviewer flags/i)).toBeVisible();
});
