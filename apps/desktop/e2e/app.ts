import { type ElectronApplication, _electron as electron, type Page } from '@playwright/test'
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

export type Launched = { app: ElectronApplication; page: Page; repo: string; close: () => Promise<void> }

/** The built app on a fake home, opened on `open` in the worktree's file viewer when given */
export async function launch(files: Record<string, string>, open?: string): Promise<Launched> {
  const { home, repo } = fakeHome(files)
  const app = await electron.launch({ args: [appDir], cwd: appDir, env: { ...process.env, HOME: home, TREEIX_USER_DATA: join(home, 'user-data'), TREEIX_HEADLESS: '1' } })
  const page = await app.firstWindow()
  // Without the repository scan the app starts with nothing selected and drops the seeded place
  await page.waitForFunction(() => localStorage.getItem('scan.cache'), null, { timeout: 30_000 })
  if (open) await page.evaluate((place) => localStorage.setItem('app.place@all', JSON.stringify(place)), { appTab: 'worktrees', selected: repo, viewer: { path: open, line: null } })
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
