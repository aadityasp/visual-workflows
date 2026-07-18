import { defineConfig } from '@playwright/test';

/**
 * E2E runs against the production-shaped stack: the bridge serving the built
 * UI on 4777 (same process users get from `visual-workflows start`).
 * VW_DATA_DIR is pointed at a throwaway dir so e2e never touches real data.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4777',
    trace: 'retain-on-failure',
  },
  webServer: {
    command:
      'npm run build -w @visual-workflows/ui && VW_DATA_DIR=/tmp/vw-e2e-data VW_PORT=4777 npm run start -w @visual-workflows/bridge',
    url: 'http://127.0.0.1:4777/health',
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
