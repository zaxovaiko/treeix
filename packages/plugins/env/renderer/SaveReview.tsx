import { matchesAction } from '@treeix/shared/keymap'
import { useEffect, useState } from 'react'
import { Keys, useHost } from '@treeix/sdk'
import { baseName, branchLabel } from '@treeix/app/Sidebar'
import { errorMessage } from '@treeix/app/ui'
import { classify, isSecretKind } from '../shared/classify'
import type { EnvEdit, WorktreeEnv } from '../shared/types'
import { folderOf } from './model'
import { MASK } from './parts'
import { envApi, envs, pending, rescan, type ScopedWorktree } from './store'

type Change = EnvEdit & { previous: string | undefined; line: number; secret: boolean; tracked: boolean }

function changeOf(edit: EnvEdit, env: WorktreeEnv | undefined): Change {
  const file = env?.files.find((candidate) => candidate.path === edit.file)
  const current = file?.vars.find((entry) => entry.name === edit.name)
  const { kind } = classify(edit.name, current?.value ?? edit.value, { frameworks: file?.frameworks, annotation: env?.annotations[folderOf(edit.file)]?.[edit.name] })
  return { ...edit, previous: current?.value, line: current?.line ?? 0, secret: isSecretKind(kind), tracked: file?.tracked ?? false }
}

/** Every unsaved value as a small diff, secrets masked, before anything is written */
export function SaveReview({ scoped, onClose }: { scoped: ScopedWorktree[]; onClose: () => void }): React.JSX.Element {
  const host = useHost()
  const edits = [...pending.use().values()]
  const known = envs.get()
  const changes = edits.map((edit) => changeOf(edit, known.get(edit.worktreePath)))
  const fileCount = new Set(edits.map((edit) => `${edit.worktreePath}|${edit.file}`)).size
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

  const save = (): void => {
    if (busy || edits.length === 0) return
    setBusy(true)
    setError(null)
    envApi
      .write(edits)
      .then(async () => {
        pending.set(new Map())
        await rescan([...new Set(edits.map((edit) => edit.worktreePath))])
        host.flash(`Saved ${plural(fileCount, 'env file')}`)
        onClose()
      })
      .catch((reason: unknown) => setError(errorMessage(reason)))
      .finally(() => setBusy(false))
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
      else if (matchesAction(event, 'env.save')) save()
      else return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const where = (edit: EnvEdit): string => {
    const owner = scoped.find((candidate) => candidate.worktree.path === edit.worktreePath)
    return owner ? `${baseName(owner.repo.path)} · ${branchLabel(owner.worktree)}` : baseName(edit.worktreePath)
  }
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div onClick={(event) => event.stopPropagation()} className="w-[720px] max-w-[90vw] overflow-hidden rounded-xl border border-input bg-popover shadow-2xl shadow-black/60">
        <div className="flex h-11 items-center gap-2 border-b border-border px-4">
          <span className="text-[13px] font-medium">
            Save {plural(edits.length, 'change')} <span className="font-normal text-muted-foreground">in {plural(fileCount, 'file')}</span>
          </span>
          <span className="flex-1" />
          <Keys combo="⌘S" />
          <Keys combo="esc" />
        </div>
        <div className="flex max-h-[52vh] flex-col gap-2 overflow-y-auto p-4 font-mono text-[11.5px]">
          {changes.map((change) => (
            <div key={`${change.worktreePath}|${change.file}|${change.name}`} className="overflow-hidden rounded-md ring-1 ring-border">
              <div className="flex items-center gap-2 bg-accent px-3 py-1.5 text-muted-foreground">
                <span className="text-foreground/85">{where(change)}</span>
                <span className="flex-1" />
                {change.file}
                {change.line ? `:${change.line}` : ''}
                <span className={`font-sans text-[10.5px] ${change.tracked ? 'text-amber-400' : 'text-muted-foreground/70'}`}>{change.tracked ? 'tracked by git' : 'not in git'}</span>
              </div>
              {change.previous !== undefined && (
                <div className="bg-red-500/10 px-3 py-0.5 break-all text-red-300">
                  - {change.name}={change.secret ? MASK : change.previous}
                </div>
              )}
              <div className="bg-emerald-500/10 px-3 py-0.5 break-all text-emerald-300">
                + {change.name}={change.secret ? MASK : change.value}
              </div>
            </div>
          ))}
        </div>
        {error && <p className="px-4 pb-2 text-xs break-words text-red-400 select-text">{error}</p>}
        <div className="flex items-center gap-3 border-t border-border px-4 py-2.5 text-xs">
          <span className="text-muted-foreground">Running terminals keep the old values until restarted.</span>
          <span className="flex-1" />
          <button onClick={onClose} className="h-7 rounded-md px-3 text-muted-foreground hover:text-foreground">
            Cancel
          </button>
          <button onClick={save} disabled={busy || edits.length === 0} className="h-7 rounded-md bg-primary px-3 font-medium text-white disabled:opacity-40">
            {busy ? 'Saving...' : `Save ${plural(fileCount, 'file')}`}
          </button>
        </div>
      </div>
    </div>
  )
}
