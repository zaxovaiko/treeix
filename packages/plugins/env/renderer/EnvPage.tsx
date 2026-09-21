import { actionForEvent, matchesAction } from '@treeix/shared/keymap'
import { useEffect, useMemo, useRef, useState } from 'react'
import { isPageKey, Kbd, PageLayout, useHost, useListNav, usePanels } from '@treeix/sdk'
import { Icon } from '@treeix/app/Icon'
import { baseName, branchLabel, ZoneHeader } from '@treeix/app/Sidebar'
import { EmptyState, IconButton, usePersisted } from '@treeix/app/ui'
import { workspaceKey } from '@treeix/app/workspaces'
import { issuesOf, issueSummary, issueTone, type Place, placesByName, worstKind } from './model'
import { KindIcon, ToggleButton, VarName } from './parts'
import { SaveReview } from './SaveReview'
import { editKey, envApi, envs, openRequest, pending, rescan, scanning, type ScopedWorktree, scopedWorktrees } from './store'
import { VariableMain } from './VariableView'
import { FreshMain, Inspector, type RowState, type Target, WorktreeMain, worktreeRows } from './WorktreeView'

type Entry = { kind: 'worktree'; target: ScopedWorktree } | { kind: 'variable'; name: string }

const WATCH_DEBOUNCE_MS = 300

/** The inspector's "Set in" stays within the repository: other repos sharing a name are unrelated */
const inRepo = (places: Place[], target: ScopedWorktree): Place[] => places.filter((place) => target.repo.worktrees.some((worktree) => worktree.path === place.worktreePath))

const ROW = 'mx-1.5 flex h-7 w-[calc(100%-12px)] items-center gap-2 rounded-md px-2 text-left hover:bg-accent'

function StatusDot({ target }: { target: ScopedWorktree }): React.JSX.Element | null {
  if (!target.env) return null
  const issues = issuesOf(target.env, target.isMain ? null : (target.main ?? null))
  if (issues.none)
    return (
      <span title="No env files" className="text-red-400">
        <Icon name="alert" className="size-3" />
      </span>
    )
  const tone = issueTone(issues)
  return tone ? <span title={issueSummary(issues)} className={`size-1.5 shrink-0 rounded-full ${tone === 'red' ? 'bg-red-400' : 'bg-amber-400'}`} /> : null
}

export function EnvPage(): React.JSX.Element {
  const host = useHost()
  const panels = usePanels()
  const known = envs.use()
  const edits = pending.use()
  const busy = scanning.use()
  const scoped = useMemo(() => scopedWorktrees(host, known), [host.repos, host.scopeRepoPaths, known])
  const [storedMode, setMode] = usePersisted<string>(workspaceKey('env.mode'), 'worktree')
  const mode = storedMode === 'variable' ? 'variable' : 'worktree'
  const [storedWorktree, setWorktree] = usePersisted<string>(workspaceKey('env.worktree'), '')
  const [name, setName] = usePersisted<string>(workspaceKey('env.name'), '')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [composing, setComposing] = useState<RowState['composing']>(null)
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set())
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  const [reviewing, setReviewing] = useState(false)
  const [showQuiet, setShowQuiet] = useState(false)
  const requested = openRequest.use().name

  // Opening the page looks again, for env files created since the last scan
  useEffect(() => void rescan(scoped.map(({ worktree }) => worktree.path)).catch(() => undefined), [])

  useEffect(() => {
    if (!requested) return
    setMode('variable')
    setName(requested)
    openRequest.update({ name: null })
  }, [requested])

  /** Repositories with an env file or template in some worktree; the others only show as a count under the list */
  const withEnv = new Set(scoped.filter(({ env }) => env && (env.files.length > 0 || env.templates.length > 0)).map(({ repo }) => repo.path))
  const quietCount = new Set(scoped.filter(({ repo }) => !withEnv.has(repo.path)).map(({ repo }) => repo.path)).size
  const target =
    scoped.find(({ worktree }) => worktree.path === storedWorktree) ??
    scoped.find(({ repo, worktree }) => worktree.path === host.selectedWorktree && withEnv.has(repo.path)) ??
    scoped.find(({ repo }) => withEnv.has(repo.path)) ??
    scoped[0]
  const index = useMemo(() => placesByName(scoped.flatMap(({ env, main, isMain }) => (env ? [{ env, main: isMain ? null : (main ?? null) }] : []))), [scoped])
  const lower = query.toLowerCase()

  const watchedPath = target?.worktree.path ?? null
  const watchedFiles = target?.env ? [...target.env.files, ...target.env.templates].map((file) => file.path).join('\n') : ''
  useEffect(() => {
    void envApi.watch(watchedPath, watchedFiles ? watchedFiles.split('\n') : []).catch(() => undefined)
    return () => void envApi.watch(null).catch(() => undefined)
  }, [watchedPath, watchedFiles])
  useEffect(() => {
    let timer = 0
    const stop = envApi.onChanged((path) => {
      clearTimeout(timer)
      timer = window.setTimeout(() => void rescan([path]).catch(() => undefined), WATCH_DEBOUNCE_MS)
    })
    return () => (stop(), clearTimeout(timer))
  }, [])

  const worktreeEntries = scoped.filter(
    ({ repo, worktree, env }) =>
      (showQuiet || withEnv.has(repo.path)) &&
      (!lower || branchLabel(worktree).toLowerCase().includes(lower) || env?.files.some((file) => file.vars.some((entry) => entry.name.toLowerCase().includes(lower) || entry.value.toLowerCase().includes(lower))))
  )
  const names = [...index.keys()].filter((candidate) => !lower || candidate.toLowerCase().includes(lower) || index.get(candidate)?.some((place) => place.value?.toLowerCase().includes(lower)))
  const entries: Entry[] = mode === 'variable' ? names.map((variable) => ({ kind: 'variable', name: variable })) : worktreeEntries.map((entry) => ({ kind: 'worktree', target: entry }))
  const cursor = entries.findIndex((entry) => (entry.kind === 'variable' ? entry.name === name : entry.target === target))
  const pick = (entry: Entry): void => {
    setSelected(null)
    setComposing(null)
    if (entry.kind === 'variable') setName(entry.name)
    else setWorktree(entry.target.worktree.path)
  }
  const nav = useListNav({ count: entries.length, index: cursor, onSelect: (next) => pick(entries[next]) })

  const shownTarget: Target | null = target?.env ? { ...target, env: target.env } : null
  const { rows } = shownTarget ? worktreeRows(shownTarget, edits) : { rows: [] }
  const selectedRow = rows.find((row) => shownTarget && editKey(shownTarget.env.path, row.file, row.name) === selected) ?? rows[0] ?? null
  const selectedKey = selectedRow && shownTarget ? editKey(shownTarget.env.path, selectedRow.file, selectedRow.name) : selected
  const fresh = shownTarget && shownTarget.env.files.length === 0 && !dismissed.has(shownTarget.env.path)
  const rowState: RowState = {
    selected: mode === 'worktree' ? selectedKey : selected,
    onSelect: setSelected,
    composing,
    setComposing,
    revealed,
    toggleReveal: (key) => setRevealed(new Set(revealed.has(key) ? [...revealed].filter((candidate) => candidate !== key) : [...revealed, key]))
  }
  const commentOnSelected = (): void => {
    if (mode === 'worktree' && selectedRow && selectedKey) setComposing({ key: selectedKey, prefill: '' })
    else if (mode === 'variable' && selected) setComposing({ key: selected, prefill: '' })
  }

  const onKey = useRef<(event: KeyboardEvent) => boolean>(() => false)
  onKey.current = (event) => {
    if (matchesAction(event, 'env.save')) {
      if (edits.size) setReviewing(true)
      return true
    }
    if (!isPageKey(event)) return false
    const action = actionForEvent(event, ['env.inspector', 'env.comment', 'env.reveal', 'env.rescan'])
    if (action === 'env.inspector' && mode === 'worktree') panels.toggle('inspector')
    else if (action === 'env.comment') commentOnSelected()
    else if (action === 'env.reveal') rowState.selected && rowState.toggleReveal(rowState.selected)
    else if (action === 'env.rescan') void rescan(scoped.map(({ worktree }) => worktree.path))
    else return false
    return true
  }
  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      if (!reviewing && onKey.current(event)) event.preventDefault()
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [reviewing])

  const repoPaths = [...new Set(worktreeEntries.map(({ repo }) => repo.path))]
  let position = -1
  const list = (
    <>
      <ZoneHeader zone="list" title="Env">
        <ToggleButton label="By worktree" on={mode === 'worktree'} onClick={() => setMode('worktree')}>
          <Icon name="list" className="size-3.5" />
        </ToggleButton>
        <ToggleButton label="By variable" on={mode === 'variable'} onClick={() => setMode('variable')}>
          <Icon name="braces" className="size-3.5" />
        </ToggleButton>
        <span className="mx-0.5 h-3.5 w-px bg-border" />
        <IconButton label={busy ? 'Scanning...' : 'Rescan (r), runs on file change too'} onClick={() => void rescan(scoped.map(({ worktree }) => worktree.path))}>
          <Icon name="refresh" className={`size-3.5 ${busy ? 'opacity-40' : ''}`} />
        </IconButton>
      </ZoneHeader>
      <div className="shrink-0 border-b border-border p-2">
        <label className="flex h-7 min-w-0 items-center gap-2 rounded-md bg-muted px-2 text-muted-foreground ring-1 ring-border">
          <Icon name="search" className="size-3.5" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter names and values"
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
          />
          <Kbd>/</Kbd>
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {entries.length === 0 && <EmptyState title={query ? 'Nothing matches' : scoped.length ? 'Scanning...' : 'No repositories in this workspace'} />}
        {mode === 'variable'
          ? names.map((variable) => {
              const places = index.get(variable) ?? []
              const kind = worstKind(places.map((place) => place.kind))
              const variants = new Set(places.flatMap((place) => (place.value === null ? [] : [place.value]))).size
              const missing = places.filter((place) => place.value === null).length
              return (
                <button key={variable} {...nav.rowProps(++position)} onClick={() => pick({ kind: 'variable', name: variable })} className={`${ROW} ${variable === name ? 'bg-accent' : ''}`}>
                  <KindIcon kind={kind} />
                  <span className={`min-w-0 flex-1 truncate font-mono text-[11.5px] ${variable === name ? 'text-foreground' : 'text-foreground/80'}`}>
                    <VarName name={variable} kind={kind} />
                  </span>
                  {(missing > 0 || variants > 1) && (
                    <span title={missing ? `${missing} missing` : `${variants} different values`} className={`size-1.5 shrink-0 rounded-full ${missing ? 'bg-red-400' : 'bg-amber-400'}`} />
                  )}
                </button>
              )
            })
          : repoPaths.map((repoPath) => {
              const repoEntries = worktreeEntries.filter(({ repo }) => repo.path === repoPath)
              const packages = new Set(repoEntries[0].main?.files.map((file) => file.path.slice(0, file.path.lastIndexOf('/') + 1))).size
              return (
                <div key={repoPath}>
                  <div className="mx-1.5 mt-2 flex h-6 items-center gap-1.5 pl-1.5">
                    <Icon name="chevron" className="size-3 rotate-90 text-muted-foreground/65" />
                    <span className="truncate text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase">{baseName(repoPath)}</span>
                    {packages > 1 && (
                      <span title={`Monorepo: env files in ${packages} packages`} className="text-muted-foreground/50">
                        <Icon name="layers" className="size-3" />
                      </span>
                    )}
                  </div>
                  {repoEntries.map((entry) => {
                    const active = entry === target
                    return (
                      <button key={entry.worktree.path} {...nav.rowProps(++position)} onClick={() => pick({ kind: 'worktree', target: entry })} className={`${ROW} ${active ? 'bg-accent' : ''}`}>
                        <Icon name={entry.isMain ? 'folder' : 'branch'} className="size-3.5 text-muted-foreground" />
                        <span className={`min-w-0 flex-1 truncate font-mono text-[11.5px] ${active ? 'text-foreground' : 'text-foreground/80'}`}>{branchLabel(entry.worktree)}</span>
                        <StatusDot target={entry} />
                      </button>
                    )
                  })}
                </div>
              )
            })}
        {mode === 'worktree' && quietCount > 0 && (
          <button onClick={() => setShowQuiet(!showQuiet)} className="mx-3 mt-3 text-left text-[11px] text-muted-foreground/70 hover:text-foreground">
            {showQuiet ? 'Hide' : 'Show'} {quietCount} repo{quietCount === 1 ? '' : 's'} without env files
          </button>
        )}
      </div>
    </>
  )

  const main =
    mode === 'variable' ? (
      <VariableMain name={name} places={index.get(name) ?? []} scoped={scoped} state={rowState} />
    ) : !target ? (
      <EmptyState fill icon="braces" title="No repositories in this workspace" />
    ) : !shownTarget ? (
      <EmptyState fill title="Scanning..." />
    ) : fresh ? (
      <FreshMain target={shownTarget} onDismiss={() => setDismissed(new Set([...dismissed, shownTarget.env.path]))} />
    ) : shownTarget.env.files.length === 0 ? (
      <EmptyState fill icon="braces" title="No env files in this worktree" />
    ) : (
      <WorktreeMain key={shownTarget.env.path} target={shownTarget} query={query} state={rowState} />
    )
  const inspector =
    mode === 'worktree' && shownTarget && shownTarget.env.files.length > 0 ? (
      <Inspector target={shownTarget} row={selectedRow} places={selectedRow ? inRepo(index.get(selectedRow.name) ?? [], shownTarget) : []} scoped={scoped} onComment={commentOnSelected} />
    ) : undefined

  return (
    <>
      <PageLayout
        listLabel="Env"
        inspectorLabel="Variable"
        inspectorWidth={270}
        listWidth={240}
        hints={{
          list: [['j k', 'move'], ['⏎', 'open'], ['/', 'filter'], ['r', 'rescan']],
          main: [['j k', 'move'], ['⏎', 'edit'], ['c', 'comment'], ['v', 'reveal'], ['i', 'inspector'], ['⌘S', 'save']]
        }}
        list={list}
        main={main}
        inspector={inspector}
      />
      {edits.size > 0 && !reviewing && (
        <div className="fixed bottom-10 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-input bg-popover py-1.5 pr-1.5 pl-3 text-xs shadow-2xl shadow-black/60">
          <span className="rounded bg-amber-400/12 px-1.5 font-mono text-amber-400">{edits.size}</span>
          <span>unsaved {edits.size === 1 ? 'change' : 'changes'}</span>
          <button onClick={() => pending.set(new Map())} className="text-muted-foreground hover:text-foreground">
            Discard
          </button>
          <button onClick={() => setReviewing(true)} className="flex h-7 items-center gap-1.5 rounded-md bg-primary px-3 font-medium text-white">
            Review and save <Kbd>⌘S</Kbd>
          </button>
        </div>
      )}
      {reviewing && <SaveReview scoped={scoped} onClose={() => setReviewing(false)} />}
    </>
  )
}
