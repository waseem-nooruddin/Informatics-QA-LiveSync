import { defineConfig, devices } from '@playwright/test';

// Requires the local stack: `npm run db:start`, `npm run functions:serve`, and apps/web/.env.local
// (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY from `supabase status`).
export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: 'http://localhost:5180', trace: 'retain-on-failure' },
  // PW_CHANNEL=chrome uses the locally installed Chrome instead of a downloaded browser.
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}) } }],
  webServer: {
    command: 'npm run dev -w @qals/web',
    url: 'http://localhost:5180',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
