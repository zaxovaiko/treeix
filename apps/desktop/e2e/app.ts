import { type ElectronApplication, _electron as electron, expect, type Page } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const appDir = resolve(__dirname, '..')

/** A throwaway HOME with one committed repository, so nothing of yours is read or touched */
function fakeHome(files: Record<string, string>): { home: string; repo: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'treeix-e2e-')))
  const repo = join(home, 'code', 'alpha')
  mkdirSync(repo, { recursive: true })
  for (const [name, text] of Object.entries(files)) writeFileSync(join(repo, name), text)
  const git = (...args: string[]): void => {
    spawnSync('git', ['-c', 'user.name=E2E', '-c', 'user.email=e2e@treeix.dev', ...args], { cwd: repo, env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' } })
  }
  git('init', '-q', '-b', 'main')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  return { home, repo }
}

/** Settings > Browser > Let agents use this browser, which is off by default */
export const AGENT_BROWSER = { 'plugin.browser.settings': JSON.stringify({ agentTools: true }) }

export type Launched = { app: ElectronApplication; page: Page; repo: string; close: () => Promise<void> }

/** Settings with the fake ACP agent as the only chat agent, so chats answer without a real one */
export const FAKE_CHAT = {
  settings: JSON.stringify({
    customAgents: [
      {
        id: 'fake',
        label: 'Fake',
        mark: 'F',
        color: '#888888',
        command: null,
        agent: true,
        chat: { adapter: 'acp', command: `"${process.execPath}" "${join(__dirname, 'fakeAcpAgent.mjs')}"` }
      }
    ],
    chatAgent: 'fake'
  })
}

/** The built app on a fake home, with `storage` seeded into localStorage */
export async function launch(files: Record<string, string>, storage: Record<string, string> = {}): Promise<Launched> {
  const { home, repo } = fakeHome(files)
  // A run killed mid-test leaves macOS window state behind, and its "reopen windows?" alert then blocks every launch
  const app = await electron.launch({
    args: [appDir, '-ApplePersistenceIgnoreState', 'YES'],
    cwd: appDir,
    env: { ...process.env, HOME: home, TREEIX_USER_DATA: join(home, 'user-data'), TREEIX_HEADLESS: '1' }
  })
  const page = await app.firstWindow()
  // The sidebar's search shows once the renderer is up, so seeded storage isn't written over by its first render
  await page.getByPlaceholder('Search').first().waitFor({ timeout: 30_000 })
  await page.evaluate((entries) => entries.forEach(([key, value]) => localStorage.setItem(key, value)), Object.entries(storage))
  await page.reload()
  return {
    app,
    page,
    repo,
    close: async () => {
      await app.close()
      // Helpers the app started can still be writing into it for a moment after close
      rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 })
    }
  }
}

/** ⌘J's terminal panel with a shell started in it */
export async function openShell(page: Page): Promise<void> {
  const shell = page.getByRole('button', { name: /Shell$/ })
  // The key is ignored until the window has focus and the host has mounted, which a loaded machine delays
  await expect(async () => {
    if (!(await shell.isVisible())) await page.keyboard.press('Meta+j')
    await expect(shell).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 30_000 })
  await shell.click()
  await page.locator('.xterm').first().waitFor()
}
