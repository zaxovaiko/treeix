import { defineConfig, devices } from '@playwright/test'

// Headless e2e on the in-browser mock daemon (src/ipc/mock.ts); the real app is covered by TREEIX_AUTORUN=e2e
const PORT = 5304
const viewport = { width: 1280, height: 800 }
// Both engines get a Mac user agent: shortcuts and the renderer follow the platform, and macOS is the one that ships
const chrome = devices['Desktop Chrome']
const macChrome = chrome.userAgent.replace(/\([^)]*\)/, '(Macintosh; Intel Mac OS X 10_15_7)')

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport } },
    { name: 'chromium', use: { ...chrome, userAgent: macChrome, viewport } },
  ],
  webServer: { command: `bunx vite --config e2e/vite.config.ts --port ${PORT} --strictPort`, url: `http://127.0.0.1:${PORT}`, reuseExistingServer: !process.env.CI },
})
