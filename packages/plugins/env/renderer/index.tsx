import { defineActions, key } from '@treeix/shared/keymap'
import { lazy, Suspense, useEffect, useRef } from 'react'
import { type Command, type HostApi, type RendererPlugin, useHost } from '@treeix/sdk'
import { baseName } from '@treeix/app/Sidebar'
import { Row, Segmented } from '@treeix/app/settingsUi'
import { errorMessage } from '@treeix/app/ui'
import { isSecretKind } from '../shared/classify'
import type { CopyMode } from '../shared/types'
import { folderOf, issuesOf, issueTone, rowsOf } from './model'
import { copyFromMain, envs, envSettings, openRequest, rescan, scopedWorktrees, TAB_ID, worktreeTitle } from './store'

// The page pulls in the editor rows, inspector and dialogs, so it loads when first opened
const EnvPage = lazy(() => import('./EnvPage').then((module) => ({ default: module.EnvPage })))

function Tab(): React.JSX.Element {
  return (
    <Suspense fallback={<div className="flex-1" />}>
      <EnvPage />
    </Suspense>
  )
}

/** Worktrees other than the one open on the page are rescanned when the window comes back, at most this often */
const FOCUS_RESCAN_MS = 60_000

/** Scans the workspace's worktrees, rescans one when its env files change, and sets up new worktrees when asked to */
function Root(): null {
  const host = useHost()
  const known = envs.use()
  const scoped = scopedWorktrees(host, known)
  const pathsKey = scoped.map(({ worktree }) => worktree.path).join('\n')
  useEffect(() => void rescan(pathsKey ? pathsKey.split('\n') : []).catch(() => undefined), [pathsKey])

  // The page watches the worktree it shows; everything else catches up when the window is focused again
  useEffect(() => {
    let last = Date.now()
    const onFocus = (): void => {
      if (Date.now() - last < FOCUS_RESCAN_MS || !pathsKey) return
      last = Date.now()
      void rescan(pathsKey.split('\n')).catch(() => undefined)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [pathsKey])

  // A worktree that appears after the first scan was just created; the host has no event for that, so compare lists
  const seen = useRef<Set<string> | null>(null)
  const allPaths = (host.repos ?? []).flatMap((repo) => repo.worktrees.map((worktree) => worktree.path))
  useEffect(() => {
    if (!host.repos) return
    const previous = seen.current
    seen.current = new Set(allPaths)
    if (!previous) return
    const { autoCopy } = envSettings.get()
    for (const target of scopedWorktrees(host, envs.get())) {
      const mode = autoCopy[target.repo.path]
      if (!mode || previous.has(target.worktree.path) || !target.main?.files.length) continue
      copyFromMain(target, mode)
        .then((created) => created && host.flash(`Env: ${created} file${created === 1 ? '' : 's'} from main in ${baseName(target.worktree.path)}`))
        .catch((reason: unknown) => host.flash(errorMessage(reason)))
    }
  }, [allPaths.join('\n')])

  return null
}

/** Red while any worktree ships a secret to the browser, lacks what its .env.example asks for, or lacks main's env files */
function Badge(): React.JSX.Element | null {
  const host = useHost()
  const known = envs.use()
  const alarming = scopedWorktrees(host, known).some(({ env, main, isMain }) => env && issueTone(issuesOf(env, isMain ? null : (main ?? null))) === 'red')
  return alarming ? <span title="Some env variables are exposed or missing, or a new worktree has none" className="size-1.5 shrink-0 rounded-full bg-red-400" /> : null
}

const openVariable = (host: HostApi, name: string): void => {
  openRequest.update({ name })
  host.setActiveTab(TAB_ID)
}

/** Every value in the palette; secrets show masked, so their values aren't searchable */
function commands(host: HostApi): Command[] {
  const scoped = scopedWorktrees(host, envs.get())
  const current = scoped.find(({ worktree }) => worktree.path === host.selectedWorktree)
  const copy: Command[] =
    current && !current.isMain && current.main?.files.length
      ? [
          {
            id: 'env:copyFromMain',
            group: 'Actions',
            label: 'Env: copy env files from main',
            icon: 'copy',
            run: () =>
              void copyFromMain(current, 'copy')
                .then((created) => host.flash(created ? `Copied ${created} env file${created === 1 ? '' : 's'} from main` : 'Every env file of main is already here'))
                .catch((reason: unknown) => host.flash(errorMessage(reason)))
          }
        ]
      : []
  const variables = scoped.flatMap((target) =>
    target.env
      ? rowsOf(target.env, target.isMain ? null : (target.main ?? null)).flatMap((row): Command[] => {
          if (row.value === null) return []
          const folder = folderOf(row.file)
          return [
            {
              id: `env:${target.worktree.path}|${row.file}|${row.name}`,
              group: 'Env',
              label: row.name,
              detail: `= ${isSecretKind(row.kind) ? '••••••' : row.value} · ${worktreeTitle(target)}${folder === '.' ? '' : ` · ${folder}`}`,
              icon: 'braces',
              run: () => openVariable(host, row.name)
            }
          ]
        })
      : []
  )
  return [...copy, ...variables]
}

const COPY_OPTIONS: [CopyMode | 'off', string][] = [
  ['off', 'Off'],
  ['copy', 'Copy'],
  ['symlink', 'Symlink'],
  ['example', 'From .env.example']
]

/** Repositories whose new worktrees get main's env files, set from the page's new worktree card */
function EnvSettings(): React.JSX.Element | null {
  const { autoCopy } = envSettings.use()
  const repos = Object.keys(autoCopy)
  if (repos.length === 0) return null
  const set = (repo: string, mode: CopyMode | 'off'): void => {
    const next = { ...autoCopy }
    if (mode === 'off') delete next[repo]
    else next[repo] = mode
    envSettings.update({ autoCopy: next })
  }
  return (
    <>
      {repos.map((repo) => (
        <Row key={repo} label={`New worktrees of ${baseName(repo)}`} description={`Env files from main go into every new worktree of ${repo}`}>
          <Segmented value={autoCopy[repo]} options={COPY_OPTIONS} onChange={(mode) => set(repo, mode)} />
        </Row>
      ))}
    </>
  )
}

defineActions([
  { id: 'env.inspector', label: 'Toggle the inspector', section: 'Env', page: TAB_ID, keys: key('KeyI') },
  { id: 'env.comment', label: 'Agent comment on the variable', section: 'Env', page: TAB_ID, keys: key('KeyC') },
  { id: 'env.reveal', label: 'Reveal or hide a secret value', section: 'Env', page: TAB_ID, keys: key('KeyV') },
  { id: 'env.save', label: 'Review and save changes', section: 'Env', page: TAB_ID, keys: key('KeyS', { meta: true }) },
  { id: 'env.rescan', label: 'Rescan env files', section: 'Env', page: TAB_ID, keys: key('KeyR') }
])

const plugin: RendererPlugin = {
  tabs: [{ id: TAB_ID, label: 'Env', icon: 'key', order: 60, render: Tab, Badge, panels: ['terminal'] }],
  Root,
  commands,
  Settings: EnvSettings
}

export default plugin
