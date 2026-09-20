import { type ActionDef, defineActions, key } from '../../shared/keymap'

/**
 * The app's own actions and the keys they ship with. Plugins add theirs the same way, from their own modules.
 * Movement inside a zone (j k, arrows, ⏎, esc) is the focus model rather than an action, so it stays fixed.
 */
export const CORE_ACTIONS: ActionDef[] = defineActions([
  { id: 'app.palette', label: 'Search everything: commands, workspaces, files, pull requests, tasks, settings', menuLabel: 'Search everything', section: 'Go to', keys: key('KeyK', { meta: true }) },
  { id: 'app.paletteAlt', label: 'Search everything, second key', section: 'Go to', keys: key('KeyP', { meta: true, shift: true }) },
  { id: 'app.leader', label: 'Leader: G then a letter, from anywhere including terminals', section: 'Go to', keys: key('KeyG', { meta: true }) },
  { id: 'app.settings', label: 'Settings', section: 'Go to', keys: key('Comma', { meta: true }) },
  { id: 'app.comments', label: 'Agent comments drawer', menuLabel: 'Agent comments', section: 'Go to', keys: key('KeyI', { meta: true }) },
  { id: 'app.search', label: 'Search across projects in scope', menuLabel: 'Search across projects', section: 'Go to', keys: key('KeyF', { meta: true, shift: true }) },
  { id: 'app.back', label: 'Back to the tab, worktree, file and line you were on', menuLabel: 'Back', section: 'Go to', keys: key('Minus', { ctrl: true }) },
  { id: 'app.forward', label: 'Forward again', menuLabel: 'Forward', section: 'Go to', keys: key('Minus', { ctrl: true, shift: true }) },
  // Pages answer to G and a letter; a key of their own is there to be recorded
  { id: 'page.worktrees', label: 'Open worktrees (G W)', menuLabel: 'Worktrees', section: 'Go to', keys: null },
  { id: 'page.terminal', label: 'Open terminal (G T)', menuLabel: 'Terminal', section: 'Go to', keys: null },
  { id: 'page.prs', label: 'Open pull requests (G P)', menuLabel: 'Pull requests', section: 'Go to', keys: null },
  { id: 'page.tasks', label: 'Open tasks (G J)', menuLabel: 'Tasks', section: 'Go to', keys: null },
  { id: 'page.confluence', label: 'Open Confluence (G C)', menuLabel: 'Confluence', section: 'Go to', keys: null },
  { id: 'page.settings', label: 'Open settings page (G S)', menuLabel: 'Settings page', section: 'Go to', keys: null },
  { id: 'app.closedSessions', label: 'Recently closed sessions (G H)', menuLabel: 'Recently closed sessions', section: 'Go to', keys: null },

  { id: 'zone.next', label: 'Next zone', section: 'Focus', keys: key('F6') },
  { id: 'zone.previous', label: 'Previous zone', section: 'Focus', keys: key('F6', { shift: true }) },
  { id: 'zone.nextAlt', label: 'Next zone, second key', section: 'Focus', keys: key('Backquote', { ctrl: true }) },
  { id: 'app.filterZone', label: 'Filter the focused list', section: 'Focus', keys: key('Slash') },
  { id: 'app.leaderBare', label: 'Leader, outside text fields and terminals', section: 'Focus', keys: key('KeyG') },

  { id: 'panel.list', label: 'Toggle list', menuLabel: 'List', section: 'Panels', keys: key('KeyE', { meta: true, shift: true }) },
  { id: 'panel.listAlt', label: 'Toggle list, second key', section: 'Panels', keys: key('KeyB', { meta: true }) },
  { id: 'panel.inspector', label: 'Toggle inspector', menuLabel: 'Inspector', section: 'Panels', keys: key('KeyB', { meta: true, alt: true }) },
  { id: 'panel.rail', label: 'Toggle workspace rail', menuLabel: 'Workspace rail', section: 'Panels', keys: key('KeyR', { meta: true, alt: true }) },
  { id: 'panel.title', label: 'Toggle title bar', menuLabel: 'Title bar', section: 'Panels', keys: key('KeyT', { meta: true, alt: true }) },
  { id: 'panel.status', label: 'Toggle status bar', menuLabel: 'Status bar', section: 'Panels', keys: key('KeyS', { meta: true, alt: true }) },
  { id: 'shell.zen', label: 'Zen: the main zone alone, no tabs, rail or bars', menuLabel: 'Zen', section: 'Panels', keys: key('Enter', { meta: true, shift: true }) },
  { id: 'app.shortcuts', label: 'Keyboard sheet', section: 'Panels', keys: key('Slash', { meta: true }) },
  { id: 'app.shortcutsBare', label: 'Keyboard sheet, second key', section: 'Panels', keys: key('Slash', { shift: true }) },

  { id: 'wt.rescan', label: 'Rescan worktrees', section: 'Worktrees', page: 'worktrees', keys: key('KeyR') },
  { id: 'wt.nextFile', label: 'Next changed file, or a new worktree in the list', section: 'Worktrees', page: 'worktrees', keys: key('KeyN') },
  { id: 'wt.previousFile', label: 'Previous changed file', section: 'Worktrees', page: 'worktrees', keys: key('KeyP') },
  { id: 'wt.lineDown', label: 'Move the line cursor down in the diff', section: 'Worktrees', page: 'worktrees', keys: key('KeyJ') },
  { id: 'wt.lineUp', label: 'Move the line cursor up in the diff', section: 'Worktrees', page: 'worktrees', keys: key('KeyK') },
  { id: 'wt.comment', label: 'Agent comment on the line', section: 'Worktrees', page: 'worktrees', keys: key('KeyC') },
  { id: 'wt.commentAlt', label: 'Agent comment on the line, second key', section: 'Worktrees', page: 'worktrees', keys: key('KeyA') },
  { id: 'wt.open', label: 'Open the file at the line to edit', section: 'Worktrees', page: 'worktrees', keys: key('KeyO') },
  { id: 'wt.copyPath', label: 'Copy the file or worktree path', section: 'Worktrees', page: 'worktrees', keys: key('KeyY') },
  { id: 'wt.diffStyle', label: 'Split or unified diff', section: 'Worktrees', page: 'worktrees', keys: key('KeyW') },
  { id: 'wt.markdown', label: 'Markdown preview', section: 'Worktrees', page: 'worktrees', keys: key('KeyM') },
  { id: 'wt.history', label: 'Edit history of the open file', section: 'Worktrees', page: 'worktrees', keys: key('KeyH') },
  { id: 'wt.terminal', label: 'Terminal in the worktree', section: 'Worktrees', page: 'worktrees', keys: key('KeyT') },
  { id: 'wt.focusProject', label: 'Focus on the project, in the list', section: 'Worktrees', page: 'worktrees', keys: key('KeyF') },
  { id: 'wt.fold', label: 'Fold or unfold all', section: 'Worktrees', page: 'worktrees', keys: key('KeyZ') },
  { id: 'wt.changedFiles', label: 'Changed files column', section: 'Worktrees', page: 'worktrees', keys: key('KeyE', { meta: true }) },
  { id: 'wt.findFile', label: 'Find a file in the explorer', section: 'Worktrees', page: 'worktrees', keys: key('KeyP', { meta: true }) },

  { id: 'app.diffStyle', label: 'Switch between split and unified diffs', menuLabel: 'Split or unified diff', section: 'Go to', keys: null },
  { id: 'app.copyComments', label: 'Copy the agent comments of the worktree', section: 'Comments', keys: null },
  { id: 'app.clearComments', label: 'Delete the agent comments of the worktree', section: 'Comments', keys: null },
  { id: 'workspace.new', label: 'New workspace', menuLabel: 'New workspace', section: 'Go to', keys: null },
  { id: 'workspace.edit', label: 'Edit the current workspace', menuLabel: 'Edit workspace', section: 'Go to', keys: null },

  { id: 'composer.save', label: 'Save the comment or message being written', section: 'Comments', keys: key('Enter', { meta: true }) },
  { id: 'composer.saveAlternative', label: 'Save it the second way, e.g. as an agent comment', section: 'Comments', keys: key('Enter', { meta: true, shift: true }) },

  { id: 'app.fontBigger', label: 'Bigger font in the focused terminal, else the editor', section: 'General', keys: key('Equal', { meta: true, alt: true }) },
  { id: 'app.fontSmaller', label: 'Smaller font', section: 'General', keys: key('Minus', { meta: true, alt: true }) },
  { id: 'app.fontDefault', label: 'Default font size', section: 'General', keys: key('Digit0', { meta: true, alt: true }) }
])

/** Ids of the Worktrees page keys, in the order its handler tries them */
export const WORKTREE_ACTIONS = CORE_ACTIONS.filter((action) => action.page === 'worktrees').map((action) => action.id)
