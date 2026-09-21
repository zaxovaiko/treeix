import { useEffect, useState } from 'react'
import { ListToggle, useHost, useListNav, usePanels } from '@treeix/sdk'
import { copyText } from '@treeix/app/contextMenu'
import { FileIcon, Icon } from '@treeix/app/Icon'
import { baseName, branchLabel } from '@treeix/app/Sidebar'
import { EmptyState, errorMessage, IconButton, TextPrompt } from '@treeix/app/ui'
import { isSecretKind, type Kind } from '../shared/classify'
import type { CopyMode, EnvEdit, Usage, WorktreeEnv } from '../shared/types'
import { fileName, folderOf, KIND_ORDER, kindOf, type Place, type Row, rowsOf, valueIn } from './model'
import { isAbout, KIND, KindIcon, MASK, Pill, RowComments, ToggleButton, ValueInput, VarName } from './parts'
import { copyFromMain, editKey, envApi, envSettings, pending, rescan, type ScopedWorktree, setPending, TAB_ID } from './store'

export type Target = ScopedWorktree & { env: WorktreeEnv }

/** The page's shared state about rows: the selected one, the open composer and revealed secrets, all by editKey */
export type RowState = {
  selected: string | null
  onSelect: (key: string) => void
  composing: { key: string; prefill: string } | null
  setComposing: (next: { key: string; prefill: string } | null) => void
  revealed: ReadonlySet<string>
  toggleReveal: (key: string) => void
}

const FRAMEWORK_TAGS: Record<string, string> = { next: 'next', vite: 'vite', expo: 'expo', nuxt: 'nuxt', prisma: 'prisma', '@nestjs/core': 'nest' }

const exposedPrompt = (name: string): string =>
  `${name} is a secret inlined into the browser bundle. Move it server-side and read it from a server route, or keep it public on purpose and mark it @public in .env.example.`

/** The worktree's rows, plus names added on this page and not saved yet */
export function worktreeRows(target: Target, edits: ReadonlyMap<string, EnvEdit>): { rows: Row[]; added: Set<string> } {
  const rows = rowsOf(target.env, target.isMain ? null : (target.main ?? null))
  const added = new Set<string>()
  for (const edit of edits.values()) {
    const file = target.env.files.find((candidate) => candidate.path === edit.file)
    if (edit.worktreePath !== target.env.path || !file || rows.some((row) => row.file === edit.file && row.name === edit.name)) continue
    added.add(`${edit.file}|${edit.name}`)
    rows.push({ file: edit.file, name: edit.name, value: null, line: 0, ...kindOf(target.env, file, edit.name, edit.value) })
  }
  return { rows, added }
}

const matches = (row: Row, query: string): boolean => !query || row.name.toLowerCase().includes(query) || (row.value ?? '').toLowerCase().includes(query)

export function WorktreeMain({ target, query, state }: { target: Target; query: string; state: RowState }): React.JSX.Element {
  const host = useHost()
  const panels = usePanels()
  const edits = pending.use()
  const [kindFilter, setKindFilter] = useState<Kind | null>(null)
  const [compare, setCompare] = useState(true)
  const [raw, setRaw] = useState(false)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [adding, setAdding] = useState(false)
  const { env, main, isMain } = target
  const { rows, added } = worktreeRows(target, edits)
  const counts = new Map<Kind, number>()
  rows.forEach((row) => counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1))
  const lower = query.toLowerCase()
  const shown = rows.filter((row) => (!kindFilter || row.kind === kindFilter) && matches(row, lower))
  const paths = env.files.map((file) => file.path)
  const multi = paths.length > 1
  const rootNames = new Set(env.files.find((file) => file.path === '.env')?.vars.map((entry) => entry.name))
  const visible = paths.flatMap((path) => (collapsed.has(path) ? [] : shown.filter((row) => row.file === path)))
  const keyOf = (row: Row): string => editKey(env.path, row.file, row.name)
  const nav = useListNav({
    zone: 'main',
    count: visible.length,
    index: visible.findIndex((row) => keyOf(row) === state.selected),
    onSelect: (index) => state.onSelect(keyOf(visible[index])),
    onOpen: (index) => document.querySelector<HTMLInputElement>(`[data-env-row="${CSS.escape(keyOf(visible[index]))}"] input`)?.focus()
  })

  const row = (entry: Row): React.JSX.Element => {
    const key = keyOf(entry)
    const mainValue = isMain ? undefined : valueIn(main ?? null, entry.file, entry.name)
    const missing = entry.value === null && !added.has(`${entry.file}|${entry.name}`)
    const differs = compare && !isMain && entry.value !== null && mainValue !== undefined && mainValue !== entry.value
    const secret = isSecretKind(entry.kind)
    const edit = edits.get(key)
    const commentCount = host.comments.filter((comment) => isAbout(comment, env.path, entry.file, entry.name)).length
    const status = missing ? (
      <Pill tone="red" title={`${folderOf(entry.file)}/.env.example has it`}>
        missing
      </Pill>
    ) : entry.kind === 'exposed' ? (
      <Pill tone="red" title={entry.reason}>
        exposed
      </Pill>
    ) : differs ? (
      <Pill tone="amber" title={`main: ${secret ? MASK : mainValue}`}>
        ≠ main
      </Pill>
    ) : added.has(`${entry.file}|${entry.name}`) || (compare && !isMain && mainValue === undefined) ? (
      <Pill tone="sky" title={added.has(`${entry.file}|${entry.name}`) ? 'Added here, not saved yet' : 'Not in main'}>
        new
      </Pill>
    ) : folderOf(entry.file) !== '.' && rootNames.has(entry.name) ? (
      <Pill tone="plain" title="The root .env sets this name too. Which one wins depends on how this package loads env, so both are shown as they are.">
        also in root
      </Pill>
    ) : null
    const comment = (): void => state.setComposing({ key, prefill: entry.kind === 'exposed' ? exposedPrompt(entry.name) : '' })
    return (
      <div key={key}>
        <div
          data-env-row={key}
          {...nav.rowProps(visible.indexOf(entry))}
          onClick={() => state.onSelect(key)}
          title={`${entry.file}${entry.line ? `:${entry.line}` : ''}`}
          className={`group mx-2 flex h-8 items-center gap-2 rounded-md px-2.5 ${key === state.selected ? 'bg-accent' : 'hover:bg-accent'}`}
        >
          <KindIcon kind={entry.kind} />
          <span className={`w-[230px] min-w-0 shrink-0 truncate font-mono text-[11.5px] ${missing ? 'text-foreground/50' : 'text-foreground/90'}`}>
            <VarName name={entry.name} kind={entry.kind} />
          </span>
          <span className="min-w-0 flex-1">
            <ValueInput
              value={edit?.value ?? entry.value ?? ''}
              dirty={edit !== undefined}
              masked={secret && !state.revealed.has(key)}
              placeholder={missing ? (mainValue !== undefined ? 'empty, main has a value' : 'empty') : ''}
              onChange={(value) => setPending({ worktreePath: env.path, file: entry.file, name: entry.name, value }, entry.value)}
            />
          </span>
          {commentCount > 0 && (
            <span className="flex items-center gap-0.5 text-[10.5px] text-primary">
              <Icon name="comment" className="size-3" />
              {commentCount}
            </span>
          )}
          {status}
          <span className="hidden items-center text-muted-foreground group-hover:flex">
            {(missing || differs) && mainValue !== undefined && (
              <IconButton label="Use the value from main" onClick={() => setPending({ worktreePath: env.path, file: entry.file, name: entry.name, value: mainValue }, entry.value)}>
                <Icon name="undo" className="size-3.5" />
              </IconButton>
            )}
            {secret && !missing && (
              <IconButton label={state.revealed.has(key) ? 'Hide (v)' : 'Reveal (v)'} onClick={() => state.toggleReveal(key)}>
                <Icon name="eye" className="size-3.5" />
              </IconButton>
            )}
            {!missing && (
              <IconButton label="Copy value" onClick={() => (copyText(edit?.value ?? entry.value ?? ''), host.flash(`Copied the value of ${entry.name}`))}>
                <Icon name="copy" className="size-3.5" />
              </IconButton>
            )}
            <IconButton label={entry.kind === 'exposed' ? 'Ask agent to fix (c)' : 'Comment to agent (c)'} onClick={comment}>
              <Icon name={entry.kind === 'exposed' ? 'wand' : 'comment'} className="size-3.5" />
            </IconButton>
          </span>
        </div>
        <RowComments
          worktreePath={env.path}
          file={entry.file}
          line={entry.line}
          name={entry.name}
          secret={secret}
          composing={state.composing?.key === key}
          prefill={state.composing?.prefill ?? ''}
          onClose={() => state.setComposing(null)}
        />
      </div>
    )
  }

  const section = (path: string): React.JSX.Element | null => {
    const sectionRows = shown.filter((entry) => entry.file === path)
    if (!sectionRows.length) return null
    const folder = folderOf(path)
    const frameworks = (env.files.find((file) => file.path === path)?.frameworks ?? []).flatMap((framework) => FRAMEWORK_TAGS[framework] ?? [])
    const open = !collapsed.has(path)
    const problems = sectionRows.some((entry) => (entry.value === null && !added.has(`${entry.file}|${entry.name}`)) || entry.kind === 'exposed')
    const toggle = (): void => setCollapsed(new Set(open ? [...collapsed, path] : [...collapsed].filter((candidate) => candidate !== path)))
    return (
      <div key={path}>
        {multi && (
          <button onClick={toggle} className="sticky top-0 z-10 mx-2 mt-2 flex h-7 w-[calc(100%-16px)] items-center gap-1.5 rounded-md bg-background/95 px-1.5 text-left text-[11.5px] backdrop-blur hover:bg-accent">
            <Icon name="chevron" className={`size-3 text-muted-foreground/65 ${open ? 'rotate-90' : ''}`} />
            <span className="font-mono">
              <span className="text-muted-foreground">{folder === '.' ? '' : `${folder}/`}</span>
              <span className="text-foreground/85">{fileName(path)}</span>
            </span>
            {folder === '.' && <span className="text-[10.5px] text-muted-foreground/60">root</span>}
            {frameworks.map((tag) => (
              <span key={tag} className="rounded bg-foreground/5 px-1 text-[10px] text-muted-foreground">
                {tag}
              </span>
            ))}
            <span className="flex-1" />
            {problems && <span className="size-1.5 rounded-full bg-red-400" />}
            <span className="text-[10.5px] text-muted-foreground/60 tabular-nums">{sectionRows.length}</span>
          </button>
        )}
        {open && sectionRows.map(row)}
      </div>
    )
  }

  const selectedFile = rows.find((entry) => editKey(env.path, entry.file, entry.name) === state.selected)?.file ?? paths[0]
  return (
    <>
      <header className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-1.5 text-[12px]">
        <ListToggle />
        <Icon name={isMain ? 'folder' : 'branch'} className="size-3.5 text-muted-foreground" />
        <span className="font-mono text-[12.5px]">{branchLabel(target.worktree)}</span>
        <span className="text-muted-foreground">{baseName(target.repo.path)}</span>
        {multi ? <span className="text-[11px] text-muted-foreground/60">{paths.length} files</span> : <span className="font-mono text-[11px] text-muted-foreground/70">{paths[0]}</span>}
        <span className="flex-1" />
        <span className="flex items-center rounded-md ring-1 ring-border">
          {KIND_ORDER.filter((kind) => counts.get(kind)).map((kind) => (
            <button
              key={kind}
              title={`${KIND[kind].label}: ${KIND[kind].note}`}
              onClick={() => setKindFilter(kindFilter === kind ? null : kind)}
              className={`flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] tabular-nums ${kindFilter === kind ? 'bg-foreground/8 text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              <KindIcon kind={kind} />
              {counts.get(kind)}
            </button>
          ))}
        </span>
        {!isMain && (
          <ToggleButton label={compare ? 'Hide differences from main' : 'Compare with main'} on={compare} onClick={() => setCompare(!compare)}>
            <Icon name="compare" className="size-3.5" />
          </ToggleButton>
        )}
        <ToggleButton label={raw ? 'Show variables' : 'Raw files'} on={raw} onClick={() => setRaw(!raw)}>
          <Icon name="code" className="size-3.5" />
        </ToggleButton>
        <ToggleButton label={`${panels.inspector ? 'Hide' : 'Show'} inspector (i)`} on={panels.inspector} onClick={() => panels.toggle('inspector')}>
          <Icon name="panel" className="size-3.5 -scale-x-100" />
        </ToggleButton>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto pb-16">
        {raw ? (
          paths.map((path) => <RawFile key={path} worktreePath={env.path} path={path} version={env} />)
        ) : (
          <>
            {paths.map(section)}
            {shown.length === 0 && <EmptyState title={query || kindFilter ? 'No variables match' : 'The env files are empty'} />}
            <button onClick={() => setAdding(true)} className="mx-2 mt-2 flex h-7 items-center gap-2 rounded-md px-2.5 text-xs text-muted-foreground hover:text-foreground">
              <Icon name="plus" className="size-3" />
              Add variable
            </button>
          </>
        )}
      </div>
      {adding && (
        <TextPrompt
          title={`Add a variable to ${selectedFile}`}
          description="Saved with the other changes after review"
          placeholder="NAME=value"
          confirmLabel="Add"
          onClose={() => setAdding(false)}
          onSubmit={async (text) => {
            const [name, ...value] = text.split('=')
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name.trim())) throw new Error('Write it as NAME=value')
            setPending({ worktreePath: env.path, file: selectedFile, name: name.trim(), value: value.join('=') }, null)
            state.onSelect(editKey(env.path, selectedFile, name.trim()))
          }}
        />
      )}
    </>
  )
}

/** The file as it is on disk, read only; `version` changes on every rescan so the text follows */
function RawFile({ worktreePath, path, version }: { worktreePath: string; path: string; version: WorktreeEnv }): React.JSX.Element {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => void window.api.readFile(worktreePath, path).then(setText), [worktreePath, path, version])
  return (
    <section className="mx-2 mt-2">
      <div className="flex h-7 items-center gap-1.5 px-1.5 font-mono text-[11.5px] text-muted-foreground">
        <FileIcon path={path} />
        {path}
      </div>
      <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-[11.5px] leading-5 text-foreground/85 select-text">{text ?? ''}</pre>
    </section>
  )
}

/** Shown for a worktree without env files: git doesn't copy ignored files into a new worktree, so offer main's */
export function FreshMain({ target, onDismiss }: { target: ScopedWorktree; onDismiss: () => void }): React.JSX.Element {
  const host = useHost()
  const files = target.main?.files ?? []
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set(files.map((file) => file.path)))
  const [mode, setMode] = useState<CopyMode>('copy')
  const [always, setAlways] = useState(true)
  const [busy, setBusy] = useState(false)
  const repoName = baseName(target.repo.path)
  const header = (
    <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-1.5 text-[12px]">
      <ListToggle />
      <Icon name={target.isMain ? 'folder' : 'branch'} className="size-3.5 text-muted-foreground" />
      <span className="font-mono text-[12.5px]">{branchLabel(target.worktree)}</span>
      <span className="text-muted-foreground">{repoName}</span>
    </header>
  )
  if (target.isMain || files.length === 0) {
    return (
      <>
        {header}
        <EmptyState fill icon="braces" title={target.isMain ? 'No env files in this worktree' : 'No env files here or in main'} />
      </>
    )
  }
  const [verb, done] = { copy: ['Copy', 'Copied'], symlink: ['Symlink', 'Symlinked'], example: ['Create', 'Created'] }[mode]
  const run = (): void => {
    setBusy(true)
    if (always) envSettings.update({ autoCopy: { ...envSettings.get().autoCopy, [target.repo.path]: mode } })
    copyFromMain(target, mode, [...chosen])
      .then((created) => host.flash(created ? `${done} ${created} env file${created === 1 ? '' : 's'}` : 'Nothing created: the files exist already, or no .env.example sits next to them'))
      .catch((reason: unknown) => host.flash(errorMessage(reason)))
      .finally(() => setBusy(false))
  }
  const check = (on: boolean): React.JSX.Element => (
    <span className={`flex size-3.5 items-center justify-center rounded-sm ${on ? 'bg-primary text-white' : 'ring-1 ring-input'}`}>{on && <Icon name="check" className="size-2.5" />}</span>
  )
  return (
    <>
      {header}
      <div className="flex flex-1 items-center justify-center">
        <div className="w-[500px] max-w-[90%] rounded-xl border border-input bg-popover p-5">
          <div className="text-[13px] font-medium">No env files in this worktree</div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Git doesn&apos;t copy gitignored files into a new worktree. <span className="font-mono text-foreground/80">{branchLabel(target.repo.worktrees[0])}</span> has{' '}
            {files.length} of them:
          </p>
          <div className="mt-2 flex flex-col gap-0.5 font-mono text-[11.5px]">
            {files.map((file) => (
              <button
                key={file.path}
                onClick={() => setChosen(new Set(chosen.has(file.path) ? [...chosen].filter((path) => path !== file.path) : [...chosen, file.path]))}
                className="flex h-6 items-center gap-2 text-left text-foreground/85"
              >
                {check(chosen.has(file.path))}
                {file.path}
                <span className="ml-auto font-sans text-[11px] text-muted-foreground">{file.vars.length}</span>
              </button>
            ))}
          </div>
          <div className="mt-4 flex h-7 rounded-md bg-muted p-0.5 text-[11.5px] ring-1 ring-border">
            {(
              [
                ['copy', 'Copy'],
                ['symlink', 'Symlink'],
                ['example', 'From .env.example']
              ] as const
            ).map(([option, label]) => (
              <button key={option} onClick={() => setMode(option)} className={`flex-1 rounded ${mode === option ? 'bg-foreground/8 text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
                {label}
              </button>
            ))}
          </div>
          <button onClick={() => setAlways(!always)} className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
            {check(always)}
            Do this for every new worktree of <span className="font-mono text-foreground/80">{repoName}</span>
          </button>
          <div className="mt-4 flex justify-end gap-2 text-xs">
            <button onClick={onDismiss} className="h-7 rounded-md px-3 text-muted-foreground hover:text-foreground">
              Not now
            </button>
            <button onClick={run} disabled={busy || chosen.size === 0} className="h-7 rounded-md bg-primary px-3 font-medium text-white disabled:opacity-40">
              {verb} {chosen.size} file{chosen.size === 1 ? '' : 's'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

/** Why the selected variable is what it is, where else it is set, and where code reads it */
export function Inspector({
  target,
  row,
  places,
  scoped,
  onComment
}: {
  target: Target
  row: Row | null
  places: Place[]
  scoped: ScopedWorktree[]
  onComment: () => void
}): React.JSX.Element {
  const host = useHost()
  const panels = usePanels()
  const [usages, setUsages] = useState<Usage[] | null>(null)
  const worktreePath = target.env.path
  useEffect(() => {
    setUsages(null)
    if (!row) return
    let current = true
    void envApi.usages(worktreePath, row.name).then((found) => current && setUsages(found))
    return () => {
      current = false
    }
  }, [worktreePath, row?.name])
  if (!row) return <EmptyState fill title="Pick a variable" />
  const { kind, reason, name } = row
  const secret = isSecretKind(kind)
  const folder = folderOf(row.file)
  const set = places.filter((place) => place.value !== null)
  const mark = (annotation: 'secret' | 'public'): void =>
    void envApi
      .mark(worktreePath, folder, name, annotation)
      .then(() => rescan([worktreePath]))
      .then(() => host.flash(`Marked ${name} @${annotation} in ${folder === '.' ? '' : `${folder}/`}.env.example`))
      .catch((reason: unknown) => host.flash(errorMessage(reason)))
  const openUsage = (usage: Usage): void =>
    host.openTab({
      key: `env:${worktreePath}:${usage.path}`,
      title: baseName(usage.path),
      icon: <FileIcon path={usage.path} />,
      parent: TAB_ID,
      content: host.renderFileView(worktreePath, usage.path, usage.line)
    })
  const where = (place: Place): string => {
    const owner = scoped.find((candidate) => candidate.worktree.path === place.worktreePath)
    if (!owner) return baseName(place.worktreePath)
    return owner.isMain ? baseName(owner.repo.path) : (branchLabel(owner.worktree).split('/').pop() ?? '')
  }
  const heading = (title: string): React.JSX.Element => <div className="mt-5 mb-1 text-[10.5px] font-medium tracking-wide text-muted-foreground/70 uppercase">{title}</div>
  return (
    <>
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border pr-1 pl-3">
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
          <VarName name={name} kind={kind} />
        </span>
        <IconButton label="Comment to agent (c)" onClick={onComment}>
          <Icon name="comment" className="size-3.5" />
        </IconButton>
        <IconButton label="Close (i)" onClick={() => panels.toggle('inspector')}>
          <Icon name="close" className="size-3" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 text-xs">
        <div className="mt-3 flex items-start gap-1.5 text-[11.5px] leading-4">
          <KindIcon kind={kind} className="mt-0.5 size-3" />
          <span>
            <span className={KIND[kind].text}>{KIND[kind].label}</span>
            <span className="text-muted-foreground">, because {reason}.</span>
          </span>
        </div>
        <div className="mt-1.5 flex gap-2 text-[11px] text-muted-foreground">
          <span>Wrong?</span>
          {kind !== 'secret' && (
            <button className="text-foreground/80 hover:underline" title={`Writes # @secret above it in ${folder}/.env.example`} onClick={() => mark('secret')}>
              mark secret
            </button>
          )}
          {secret && (
            <button className="text-foreground/80 hover:underline" title={`Writes # @public above it in ${folder}/.env.example`} onClick={() => mark('public')}>
              mark public
            </button>
          )}
        </div>
        {heading(`Set in · ${set.length}`)}
        {set.map((place) => (
          <div key={editKey(place.worktreePath, place.file, name)} className="flex h-6 items-center gap-2">
            <span className="w-[130px] truncate text-muted-foreground" title={`${place.worktreePath} ${place.file}`}>
              {where(place)}
              {folderOf(place.file) !== '.' && <span className="font-mono text-foreground/60"> {folderOf(place.file).split('/').pop()}</span>}
            </span>
            <span className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-foreground/75">{secret ? MASK : place.value}</span>
          </div>
        ))}
        {heading(`Read in code · ${usages?.length ?? '…'}`)}
        {usages?.length === 0 && <div className="text-[11px] text-muted-foreground">Not referenced in tracked code</div>}
        {usages?.map((usage) => (
          <button
            key={`${usage.path}:${usage.line}`}
            onClick={() => openUsage(usage)}
            title={usage.path}
            className="-mx-1 flex h-6 w-[calc(100%+8px)] items-center gap-2 rounded px-1 text-left hover:bg-accent"
          >
            <span className="truncate font-mono text-[11px] text-foreground/80">{usage.path.split('/').slice(-2).join('/')}</span>
            <span className="ml-auto font-mono text-[10.5px] text-muted-foreground">{usage.line}</span>
          </button>
        ))}
      </div>
    </>
  )
}
