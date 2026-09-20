import { useEffect, useRef, useState } from 'react'
import type { Branch, Repo } from '../../shared/types'
import { Icon } from './Icon'
import { KindBadge } from './sessionUi'
import { baseName, branchAge } from './Sidebar'
import { Kbd, SESSION_KINDS, type SessionKind } from '@treeix/sdk'
import { useService } from './plugins'
import { errorMessage, Popup, usePersisted } from './ui'

export type NewBranchRequest = { repoPath: string; name: string; base: string; worktree: boolean; session: SessionKind | null }

const localName = (branch: string): string => branch.replace(/^origin\//, '')

const MAX_SUGGESTIONS = 50

/** Text field with a themed branch suggestion list; native datalist and select popups ignore the app styling */
function BranchCombobox({
  value,
  onChange,
  branches,
  placeholder,
  autoFocus = false,
  onSubmit
}: {
  value: string
  onChange: (value: string) => void
  branches: Branch[]
  placeholder: string
  autoFocus?: boolean
  onSubmit?: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const needle = value.trim().toLowerCase()
  const exact = branches.some((branch) => branch.name.toLowerCase() === needle)
  // Showing the full list once a branch is picked makes switching to another one easy
  const suggestions = branches.filter((branch) => exact || !needle || branch.name.toLowerCase().includes(needle)).slice(0, MAX_SUGGESTIONS)

  useEffect(() => listRef.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' }), [active])

  const pick = (branch: Branch): void => {
    onChange(branch.name)
    setOpen(false)
  }

  return (
    <div className="relative mt-1">
      <input
        ref={inputRef}
        autoFocus={autoFocus}
        value={value}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => {
          onChange(event.target.value)
          setActive(0)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setOpen(true)
            setActive((index) => Math.max(0, Math.min(suggestions.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))))
          } else if (event.key === 'Enter') {
            event.preventDefault()
            event.stopPropagation()
            if (open && suggestions[active] && suggestions[active].name !== value) pick(suggestions[active])
            else onSubmit?.()
          } else if (event.key === 'Escape' && open) {
            event.stopPropagation()
            setOpen(false)
          }
        }}
        placeholder={placeholder}
        className="h-8 w-full rounded-md border border-input bg-muted px-2.5 pr-7 font-mono text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70"
      />
      <Icon name="chevron" className="pointer-events-none absolute top-2.5 right-2.5 size-3 rotate-90 text-muted-foreground" />
      {open && suggestions.length > 0 && (
        <Popup ref={listRef} anchor={inputRef} align="stretch" className="max-h-56 overflow-y-auto rounded-lg border border-input bg-popover p-1">
          {suggestions.map((branch, index) => (
            <button
              key={branch.name}
              data-active={index === active || undefined}
              // mousedown keeps focus in the input, so blur doesn't close the list before the click lands
              onMouseDown={(event) => {
                event.preventDefault()
                pick(branch)
              }}
              onMouseEnter={() => setActive(index)}
              className={`flex h-7 w-full items-center gap-2 rounded-md px-2 text-left ${index === active ? 'bg-accent text-foreground' : 'text-foreground/80'}`}
            >
              <Icon name={branch.remote ? 'external' : 'branch'} className="size-3 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{branch.name}</span>
              {branch.name === value && <Icon name="check" className="size-3 shrink-0 text-foreground" />}
              <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{branchAge(branch)}</span>
            </button>
          ))}
        </Popup>
      )}
    </div>
  )
}

/** New branch, optionally checked out as a worktree with a session already running in it */
export function BranchDialog({
  repo,
  initialName = '',
  initialWorktree = true,
  initialBase = '',
  onSubmit,
  onClose
}: {
  repo: Repo
  initialName?: string
  initialWorktree?: boolean
  initialBase?: string
  onSubmit: (request: NewBranchRequest) => Promise<void>
  onClose: () => void
}): React.JSX.Element {
  const [branches, setBranches] = useState<Branch[] | null>(null)
  const [name, setName] = useState(initialName)
  const [worktree, setWorktree] = useState(initialWorktree)
  const [session, setSession] = usePersisted<string>('branchDialog.session', 'none')
  const [busy, setBusy] = useState(false)
  const sessionsAvailable = useService('sessions') !== null
  const [error, setError] = useState<string | null>(null)
  const mainBranch = repo.worktrees.find((candidate) => candidate.path === repo.path)?.branch ?? ''
  const [base, setBase] = useState(initialBase || mainBranch)

  useEffect(() => {
    window.api.listBranches(repo.path).then(setBranches, () => setBranches([]))
  }, [repo.path])

  const existing = branches?.find((branch) => localName(branch.name) === name.trim())
  const baseValue = base.trim() || 'HEAD'
  const sessionKind = !sessionsAvailable || session === 'none' ? null : (session as SessionKind)

  const submit = (): void => {
    if (!name.trim() || busy || (!worktree && existing)) return
    setBusy(true)
    setError(null)
    onSubmit({ repoPath: repo.path, name: localName(name.trim()), base: baseValue, worktree, session: worktree ? sessionKind : null })
      .then(onClose)
      .catch((reason: unknown) => setError(errorMessage(reason)))
      .finally(() => setBusy(false))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[14vh] backdrop-blur-[2px]" onClick={onClose}>
      <div
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose()
          if (event.key === 'Enter' && event.metaKey) submit()
        }}
        className="w-[480px] max-w-[92vw] rounded-xl border border-border bg-popover p-4 shadow-2xl shadow-black/60 backdrop-blur-2xl"
      >
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 truncate text-sm font-medium">
            {worktree ? 'New worktree' : 'New branch'} in {baseName(repo.path)}
          </h2>
          <span className="flex-1" />
          <Kbd hint>esc</Kbd>
        </div>

        <label className="mt-3 block text-xs text-muted-foreground">Branch</label>
        <BranchCombobox autoFocus value={name} onChange={setName} branches={branches ?? []} placeholder="feat/my-branch" onSubmit={submit} />
        <p className="mt-1 h-4 text-[11px] text-muted-foreground">
          {existing ? `Exists${existing.remote ? ' on origin' : ''}, will be checked out` : name.trim() ? 'New branch' : ''}
        </p>

        {!existing && (
          <>
            <label className="mt-2 block text-xs text-muted-foreground">Start from</label>
            <BranchCombobox value={base} onChange={setBase} branches={branches ?? []} placeholder="dev" onSubmit={submit} />
          </>
        )}

        <button onClick={() => setWorktree(!worktree)} className="mt-4 flex w-full items-center gap-2.5 text-left text-[13px]">
          <span className={`grid size-4 place-items-center rounded ${worktree ? 'bg-primary text-white' : 'ring-1 ring-input'}`}>
            {worktree && <Icon name="check" className="size-3" />}
          </span>
          Check out in a new worktree
          <span className="text-xs text-muted-foreground">.claude/worktrees</span>
        </button>

        {worktree && sessionsAvailable && (
          <div className="mt-3 flex items-center gap-1.5">
            <span className="mr-1 text-xs text-muted-foreground">Then open</span>
            {(['none', 'shell', 'claude', 'codex'] as const).map((kind) => (
              <button
                key={kind}
                onClick={() => setSession(kind)}
                className={`flex h-7 items-center gap-1.5 rounded-md px-2 text-xs ring-1 ${
                  session === kind ? 'bg-foreground/[.08] text-foreground ring-input' : 'text-muted-foreground ring-border hover:bg-accent'
                }`}
              >
                {kind === 'none' ? 'Nothing' : (
                  <>
                    <KindBadge kind={kind} />
                    {SESSION_KINDS[kind].label}
                  </>
                )}
              </button>
            ))}
          </div>
        )}

        {error && <p className="mt-3 text-xs break-words text-red-400 select-text">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="h-7 rounded-md px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
            Cancel
          </button>
          <button onClick={submit} disabled={!name.trim() || busy || (!worktree && Boolean(existing))} className="flex h-7 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-white disabled:opacity-40">
            {busy ? 'Creating…' : worktree ? 'Create worktree' : existing ? 'Branch exists' : 'Create branch'}
            <Kbd hint>⌘⏎</Kbd>
          </button>
        </div>
      </div>
    </div>
  )
}
