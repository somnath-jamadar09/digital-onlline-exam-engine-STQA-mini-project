'use strict';
const { defineConfig, devices } = require('@playwright/test');

const PORT = 3200;

module.exports = defineConfig({
  testDir: './tests/ui',
  timeout: 60_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  workers: 4,
  retries: 0,
  reporter: [
    ['list'],
    ['json', { outputFile: 'results/ui-results.json' }],
    ['html', { outputFolder: 'results/ui-report', open: 'never' }],
  ],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'node server/index.js',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 20_000,
    env: {
      PORT: String(PORT),
      GRACE_MS: '1500', // short grace so expiry tests run in seconds
      SWEEP_MS: '250',
      NODE_NO_WARNINGS: '1',
    },
  },
});
