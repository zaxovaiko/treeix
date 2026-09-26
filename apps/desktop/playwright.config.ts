import { defineConfig } from '@playwright/test'

// Named *.e2e.ts so `bun test` doesn't pick them up; they run against the last `electron-vite build`
export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.e2e.ts',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure', actionTimeout: 10_000 }
})
