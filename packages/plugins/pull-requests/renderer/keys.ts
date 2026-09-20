import { useEffect, useRef } from 'react'
import type { IconName } from '@treeix/app/Icon'
import { type Command, isPageKey, type ShortcutInfo } from '@treeix/sdk'

export type Verb =
  | 'conversation'
  | 'files'
  | 'nextFile'
  | 'previousFile'
  | 'comment'
  | 'agent'
  | 'edit'
  | 'delete'
  | 'resolve'
  | 'viewed'
  | 'review'
  | 'merge'
  | 'ready'
  | 'worktree'
  | 'open'
  | 'copy'
  | 'sort'
  | 'involves'
  | 'filter'
  | 'fold'

/** Every single-key verb of the page: `key` is KeyboardEvent.key, so ⇧S is 'S' */
const VERBS: { verb: Verb; key: string; label: string; icon: IconName }[] = [
  { verb: 'conversation', key: '[', label: 'Show conversation', icon: 'comment' },
  { verb: 'files', key: ']', label: 'Show files changed', icon: 'file' },
  { verb: 'nextFile', key: 'n', label: 'Next file', icon: 'chevron' },
  { verb: 'previousFile', key: 'p', label: 'Previous file', icon: 'chevron' },
  { verb: 'comment', key: 'c', label: 'Comment, or reply to the thread under the cursor', icon: 'comment' },
  { verb: 'agent', key: 'a', label: 'Add the thread or file to agent comments', icon: 'plus' },
  { verb: 'edit', key: 'e', label: 'Edit your comment in the thread under the cursor', icon: 'pencil' },
  { verb: 'delete', key: 'd', label: 'Delete your comment in the thread under the cursor', icon: 'trash' },
  { verb: 'resolve', key: 'x', label: 'Resolve or reopen the thread', icon: 'check' },
  { verb: 'viewed', key: 'v', label: 'Mark the file viewed', icon: 'eye' },
  { verb: 'review', key: 'r', label: 'Review: approve or request changes', icon: 'eye' },
  { verb: 'merge', key: 'm', label: 'Merge, squash or rebase', icon: 'pullRequest' },
  { verb: 'ready', key: 'R', label: 'Mark a draft ready for review, or convert back to draft', icon: 'check' },
  { verb: 'worktree', key: 'w', label: 'Open the worktree for the branch, or create it', icon: 'branch' },
  { verb: 'open', key: 'o', label: 'Open in the browser', icon: 'external' },
  { verb: 'copy', key: 'y', label: 'Copy link', icon: 'copy' },
  { verb: 'sort', key: 'S', label: 'Sort pull requests', icon: 'sort' },
  { verb: 'involves', key: 'f', label: 'Only pull requests that involve you', icon: 'search' },
  { verb: 'filter', key: '/', label: 'Filter pull requests', icon: 'search' },
  { verb: 'fold', key: 'z', label: 'Fold or unfold all groups, or the folders of the files changed', icon: 'collapseAll' }
]

const keysOf = (key: string): string => (/^[A-Z]$/.test(key) ? `⇧${key}` : key)

export const PULL_REQUEST_SHORTCUTS: ShortcutInfo[] = [
  ...VERBS.map(({ key, label }) => ({ keys: keysOf(key), label, section: 'Pull requests', page: 'prs' })),
  { keys: '⌘P', label: 'Go to a changed file', section: 'Pull requests', page: 'prs' },
  { keys: '⌘⇧↵', label: 'Add a draft comment to agent comments instead of posting it', section: 'Pull requests', page: 'prs' }
]

type Handlers = Partial<Record<Verb, () => void>>

/** Handlers of the views on screen, the list's and the pull request's, for the palette */
const sources = new Set<() => Handlers>()

/** Palette entries for what the pull request on screen can do right now */
export function pullRequestCommands(): Command[] {
  const handlers: Handlers = Object.assign({}, ...[...sources].map((get) => get()))
  return VERBS.flatMap(({ verb, key, label, icon }) => {
    const run = handlers[verb]
    return run ? [{ id: `prs:${verb}`, group: 'Actions', label, icon, shortcut: keysOf(key), run }] : []
  })
}

/** Bare-key verbs while focus is in the page's zones; only the verbs passed this render are live */
export function usePullRequestKeys(handlers: Handlers): void {
  const latest = useRef(handlers)
  latest.current = handlers
  useEffect(() => {
    const get = (): Handlers => latest.current
    sources.add(get)
    const onKey = (event: KeyboardEvent): void => {
      if (!isPageKey(event)) return
      const verb = VERBS.find((entry) => entry.key === event.key)?.verb
      const run = verb && latest.current[verb]
      if (!run) return
      event.preventDefault()
      run()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      sources.delete(get)
      window.removeEventListener('keydown', onKey)
    }
  }, [])
}
