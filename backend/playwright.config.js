// @ts-check
const { defineConfig, devices } = require('@playwright/test');
const path = require('path');
const os = require('os');

// Every E2E run gets a throwaway database. Never the production file.
const E2E_DB = path.join(os.tmpdir(), `sms-e2e-${process.pid}.sqlite`);
const PORT = process.env.E2E_PORT || 4610;

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  expect: { timeout: 7000 },
  fullyParallel: false,       // one server, one database
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: process.env.CI ? 'retain-on-failure' : 'off',
    viewport: { width: 1600, height: 950 }
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } }
  ],

  // Seed a fresh database, then boot the REAL server against it.
  webServer: {
    command: `node tests/seed.js && node server.js`,
    url: `http://127.0.0.1:${PORT}/login`,
    reuseExistingServer: false,
    timeout: 60000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      SMS_DB_PATH: E2E_DB,
      PORT: String(PORT),
      NODE_ENV: 'test'
    }
  }
});
