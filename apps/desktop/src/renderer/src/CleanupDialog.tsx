import { useEffect, useState } from 'react'
import type { Repo } from '../../shared/types'
import { Icon } from './Icon'
import { Kbd } from '@treeix/sdk'
import { baseName, branchLabel } from './Sidebar'
import { errorMessage } from './ui'
import { type CleanupCandidate, cleanupCandidates } from './worktreePlans'

/** Lists worktrees that look finished and removes the checked ones */
export function CleanupDialog({ repos, onRemoved, onClose }: { repos: Repo[]; onRemoved: (paths: string[]) => void; onClose: () => void }): React.JSX.Element {
  const [candidates, setCandidates] = useState<CleanupCandidate[] | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all(repos.map(async (repo) => [repo.path, await window.api.listBranches(repo.path).catch(() => [])] as const)).then((entries) => {
      const found = cleanupCandidates(repos, new Map(entries), Date.now() / 1000)
      setCandidates(found)
      setChecked(new Set(found.filter(({ suggested }) => suggested).map(({ worktree }) => worktree.path)))
    })
    // Checked once on open; the parent passes a new array every render
  }, [])

  const toggle = (path: string): void => {
    const next = new Set(checked)
    if (!next.delete(path)) next.add(path)
    setChecked(next)
  }

  const remove = async (): Promise<void> => {
    const chosen = (candidates ?? []).filter(({ worktree }) => checked.has(worktree.path))
    if (chosen.length === 0 || busy) return
    setBusy(true)
    setError(null)
    const removed: string[] = []
    for (const { worktree } of chosen) {
      try {
        await window.api.removeWorktree(worktree.path, worktree.changedFiles > 0)
        removed.push(worktree.path)
      } catch (reason) {
        setError(`${branchLabel(worktree)}: ${errorMessage(reason)}`)
      }
    }
    setBusy(false)
    onRemoved(removed)
    if (removed.length === chosen.length) onClose()
    else setCandidates((current) => current?.filter(({ worktree }) => !removed.includes(worktree.path)) ?? null)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[14vh] backdrop-blur-[2px]" onClick={onClose}>
      <div
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose()
          if (event.key === 'Enter' && event.metaKey) void remove()
        }}
        tabIndex={-1}
        autoFocus
        className="w-[520px] max-w-[92vw] rounded-xl border border-border bg-popover p-4 shadow-2xl shadow-black/60 outline-none backdrop-blur-2xl"
      >
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium">Clean up worktrees</h2>
          <span className="flex-1" />
          <Kbd hint>esc</Kbd>
        </div>
        <div className="mt-3 max-h-[50vh] overflow-y-auto">
          {candidates === null && <p className="text-xs text-muted-foreground">Checking branches…</p>}
          {candidates?.length === 0 && <p className="text-xs text-muted-foreground">Nothing to clean up: every worktree is on a live branch with recent commits.</p>}
          {candidates?.map(({ repo, worktree, reason }) => (
            <button key={worktree.path} onClick={() => toggle(worktree.path)} className="flex h-8 w-full items-center gap-2.5 rounded-md px-1.5 text-left text-[13px] hover:bg-accent">
              <span className={`grid size-4 shrink-0 place-items-center rounded ${checked.has(worktree.path) ? 'bg-primary text-white' : 'ring-1 ring-input'}`}>
                {checked.has(worktree.path) && <Icon name="check" className="size-3" />}
              </span>
              <span className="min-w-0 truncate font-mono text-[12.5px]">{branchLabel(worktree)}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">{baseName(repo.path)}</span>
              <span className="flex-1" />
              {worktree.changedFiles > 0 && <span className="shrink-0 text-[11px] text-amber-400">{worktree.changedFiles} uncommitted</span>}
              <span className="shrink-0 text-[11px] text-muted-foreground">{reason}</span>
            </button>
          ))}
        </div>
        {error && <p className="mt-3 text-xs break-words text-red-400 select-text">{error}</p>}
        <div className="mt-4 flex items-center justify-end gap-2">
          <span className="mr-auto text-[11px] text-muted-foreground">Branches are kept</span>
          <button onClick={onClose} className="h-7 rounded-md px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
            Cancel
          </button>
          <button onClick={() => void remove()} disabled={checked.size === 0 || busy} className="flex h-7 items-center gap-1.5 rounded-md bg-red-500/90 px-3 text-xs font-medium text-white disabled:opacity-40">
            {busy ? 'Removing…' : `Remove ${checked.size} ${checked.size === 1 ? 'worktree' : 'worktrees'}`}
            <Kbd hint>⌘⏎</Kbd>
          </button>
        </div>
      </div>
    </div>
  )
}
