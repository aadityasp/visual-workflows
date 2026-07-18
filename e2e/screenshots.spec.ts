import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';

/**
 * Not a test — a screenshot generator for README/deliverable assets. Run with
 *   npx playwright test screenshots.spec.ts
 * Writes PNGs to assets/screenshots/. Drives the real bridge + built UI.
 */

const OUT = path.join(process.cwd(), 'assets', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

const DATA_DIR = process.env.VW_DATA_DIR ?? '/tmp/vw-e2e-data';
const readToken = () => fs.readFileSync(path.join(DATA_DIR, 'token'), 'utf8').trim();

async function selectSession(page: Page, sessionId: string) {
  await page.getByRole('combobox', { name: 'Session' }).selectOption(`live:${sessionId}`);
}

test.use({ viewport: { width: 1600, height: 1000 } });

test('capture: empty state (dark)', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /run the demo/i })).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, '01-empty-dark.png') });
});

test('capture: live demo mid-run + completed (dark & light)', async ({ page, request }) => {
  await page.goto('/');
  const res = await request.post('/demo/start', { data: { speed: 3 } });
  const { sessionId } = (await res.json()) as { sessionId: string };
  await selectSession(page, sessionId);

  // Mid-run: wait for the parallel coders, let a little motion accrue.
  await expect(page.getByRole('group', { name: /^Coder A/ })).toBeVisible();
  await expect(page.getByRole('group', { name: /^Coder B/ })).toBeVisible();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, '02-demo-midrun-dark.png') });

  // Light theme mid-run.
  await page.getByRole('button', { name: /toggle theme/i }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, '03-demo-midrun-light.png') });
  await page.getByRole('button', { name: /toggle theme/i }).click();

  // Completed board.
  await expect(page.getByRole('group', { name: /^Tester.*Done/i })).toBeVisible({
    timeout: 40_000,
  });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, '05-demo-complete-dark.png') });
});

test('capture: attention rail with an approval', async ({ page, request }) => {
  await page.goto('/');
  const token = readToken();
  const sessionId = `shot-approval-${Date.now()}`;
  const now = () => new Date().toISOString();
  await postApproval(request, token, sessionId, now);
  await selectSession(page, sessionId);
  await expect(page.getByText(/needs attention/i)).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, '04-attention-rail.png') });
});

async function postApproval(
  request: APIRequestContext,
  token: string,
  sessionId: string,
  now: () => string,
) {
  const events = [
    { ts: now(), source: 'manual', sessionId, type: 'session_started', payload: { title: 'Demo' } },
    {
      ts: now(),
      source: 'manual',
      sessionId,
      agentId: 'main',
      type: 'agent_created',
      payload: { name: 'Main agent', kind: 'main' },
    },
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
      type: 'dependency_created',
      payload: { fromAgentId: 'main', toAgentId: 'reviewer', kind: 'reviews' },
    },
    {
      ts: now(),
      source: 'manual',
      sessionId,
      agentId: 'reviewer',
      type: 'approval_requested',
      payload: {
        requestId: 'req-shot-1',
        kind: 'question',
        prompt: 'Reviewer flags: ThemeProvider drops user preference on reload. Apply the fix?',
      },
    },
  ];
  await request.post('/ingest', {
    headers: { 'x-vw-token': token, 'content-type': 'application/json' },
    data: events,
  });
}
