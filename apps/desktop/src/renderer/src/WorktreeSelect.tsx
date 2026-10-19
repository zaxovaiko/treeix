import { useState } from 'react'
import { useHost } from '@treeix/sdk'
import { Select } from './Picker'
import { baseName, branchLabel } from './Sidebar'

/**
 * The folder a page reads: the selected worktree, else the workspace folder, until another checkout is picked. A new
 * selection or workspace wins over the pick. Home is too big to scan, so it reads as null there
 */
export function useWorktreeFolder(): [string | null, (path: string) => void] {
  const { defaultCwd } = useHost()
  const [picked, setPicked] = useState<{ over: string; path: string } | null>(null)
  const folder = picked?.over === defaultCwd ? picked.path : defaultCwd
  return [folder === window.api.home ? null : folder, (path) => setPicked({ over: defaultCwd, path })]
}

/** Every checkout of the workspace's projects, its project beside it */
export function WorktreeSelect({ value, onChange }: { value: string | null; onChange: (path: string) => void }): React.JSX.Element {
  const host = useHost()
  const repos = (host.repos ?? []).filter((repo) => !host.scopeRepoPaths || host.scopeRepoPaths.includes(repo.path))
  const listed = repos.flatMap((repo) => repo.worktrees.map((worktree) => ({ value: worktree.path, label: branchLabel(worktree), hint: baseName(repo.path) })))
  // A folder outside the scanned projects, like a chat's, shows by its own name
  const options = value && !listed.some((option) => option.value === value) ? [{ value, label: baseName(value) }, ...listed] : listed
  return (
    <div className="w-40 min-w-0 shrink-0">
      <Select title="Worktree to read" placeholder="Pick a worktree" value={value} options={options} onChange={onChange} transparent />
    </div>
  )
}
