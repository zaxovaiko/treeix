import { useEffect, useRef } from 'react'
import type { IconName } from '@treeix/app/Icon'
import { type Command, isPageKey, useHost } from '@treeix/sdk'
import { actionForEvent, actionKeys, defineActions, key } from '@treeix/shared/keymap'

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
  | 'assign'
  | 'close'
  | 'worktree'
  | 'open'
  | 'copy'
  | 'sort'
  | 'involves'
  | 'filter'
  | 'fold'

/** Every verb of the page, with the key it ships with; Settings rebinds them through the keymap */
const VERBS: { verb: Verb; code: string; shift?: boolean; label: string; icon: IconName }[] = [
  { verb: 'conversation', code: 'BracketLeft', label: 'Show conversation', icon: 'comment' },
  { verb: 'files', code: 'BracketRight', label: 'Show files changed', icon: 'file' },
  { verb: 'nextFile', code: 'KeyN', label: 'Next file', icon: 'chevron' },
  { verb: 'previousFile', code: 'KeyP', label: 'Previous file', icon: 'chevron' },
  { verb: 'comment', code: 'KeyC', label: 'Comment, or reply to the thread under the cursor', icon: 'comment' },
  { verb: 'agent', code: 'KeyA', label: 'Add the thread or file to agent comments', icon: 'plus' },
  { verb: 'edit', code: 'KeyE', label: 'Edit your comment in the thread under the cursor', icon: 'pencil' },
  { verb: 'delete', code: 'KeyD', label: 'Delete your comment in the thread under the cursor', icon: 'trash' },
  { verb: 'resolve', code: 'KeyX', label: 'Resolve or reopen the thread', icon: 'check' },
  { verb: 'viewed', code: 'KeyV', label: 'Mark the file viewed', icon: 'eye' },
  { verb: 'review', code: 'KeyR', label: 'Review: approve or request changes', icon: 'eye' },
  { verb: 'merge', code: 'KeyM', label: 'Merge, squash or rebase', icon: 'pullRequest' },
  { verb: 'ready', code: 'KeyR', shift: true, label: 'Mark a draft ready for review, or convert back to draft', icon: 'check' },
  { verb: 'assign', code: 'KeyA', shift: true, label: 'Assign or unassign people', icon: 'user' },
  { verb: 'close', code: 'KeyC', shift: true, label: 'Close without merging', icon: 'close' },
  { verb: 'worktree', code: 'KeyW', label: 'Open the worktree for the branch, or create it', icon: 'branch' },
  { verb: 'open', code: 'KeyO', label: 'Open in the browser', icon: 'external' },
  { verb: 'copy', code: 'KeyY', label: 'Copy link', icon: 'copy' },
  { verb: 'sort', code: 'KeyS', shift: true, label: 'Sort pull requests', icon: 'sort' },
  { verb: 'involves', code: 'KeyF', label: 'Only pull requests that involve you', icon: 'search' },
  { verb: 'filter', code: 'Slash', label: 'Filter pull requests', icon: 'search' },
  { verb: 'fold', code: 'KeyZ', label: 'Fold or unfold all groups, or the folders of the files changed', icon: 'collapseAll' }
]

const PAGE = 'prs'
const idOf = (verb: Verb): string => `prs.${verb}`

defineActions([
  ...VERBS.map(({ verb, code, shift, label }) => ({ id: idOf(verb), label, section: 'Pull requests', page: PAGE, keys: key(code, { shift }) })),
  { id: 'prs.findFile', label: 'Go to a changed file', section: 'Pull requests', page: PAGE, keys: key('KeyP', { meta: true }) },
  { id: 'prs.draftComment', label: 'Add a draft comment to agent comments instead of posting it', section: 'Pull requests', page: PAGE, keys: key('Enter', { meta: true, shift: true }) }
])

type Handlers = Partial<Record<Verb, () => void>>

/** Handlers of the views on screen, the list's and the pull request's, for the palette */
const sources = new Set<() => Handlers>()

/** Palette entries for what the pull request on screen can do right now */
export function pullRequestCommands(): Command[] {
  const handlers: Handlers = Object.assign({}, ...[...sources].map((get) => get()))
  return VERBS.flatMap(({ verb, label, icon }) => {
    const run = handlers[verb]
    return run ? [{ id: `prs:${verb}`, group: 'Actions', label, icon, shortcut: actionKeys(idOf(verb)) || undefined, run }] : []
  })
}

/** Bare-key verbs while focus is in the page's zones; only the verbs passed this render are live */
export function usePullRequestKeys(handlers: Handlers): void {
  const latest = useRef(handlers)
  latest.current = handlers
  // The page keeps this listener while it sits off screen, so it only acts when the keys are its own
  const mine = useRef(false)
  mine.current = useHost().keyboardPage === PAGE
  useEffect(() => {
    const get = (): Handlers => latest.current
    sources.add(get)
    const onKey = (event: KeyboardEvent): void => {
      if (!mine.current || !isPageKey(event)) return
      const id = actionForEvent(event, VERBS.map(({ verb }) => idOf(verb)))
      const verb = VERBS.find((entry) => idOf(entry.verb) === id)?.verb
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
