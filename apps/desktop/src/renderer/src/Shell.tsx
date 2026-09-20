import { useEffect, useRef, useState } from 'react'
import { cycleZone, getShell, isTyping, type KeyHint, KeyHintLabel, Keys, type ShortcutInfo, toggleZen, updateShell, useShell, useZone, type ZoneId } from '@treeix/sdk'
import { Icon, type IconName } from './Icon'
import { usePlugins } from './plugins'
import { DIGIT_MODIFIERS, useSettings } from './settings'

/** G then a letter goes to a page, by tab id; pages of plugins that are off are skipped */
export const LEADER_PAGES: Record<string, string> = { t: 'terminal', p: 'prs', w: 'worktrees', j: 'tasks', c: 'confluence', s: 'settings' }
export const leaderOf = (page: string): string | undefined => Object.keys(LEADER_PAGES).find((letter) => LEADER_PAGES[letter] === page)

const CORE_SHORTCUTS: ShortcutInfo[] = [
  ...(
    [
      ['⌘K', 'Command palette, also ⌘⇧P'],
      ['G T', 'Terminal'],
      ['G P', 'Pull requests'],
      ['G W', 'Worktrees'],
      ['G J', 'Tasks'],
      ['G C', 'Confluence'],
      ['G S', 'Settings'],
      ['G 1-9', 'Workspace by rail order'],
      ['G H', 'Recently closed sessions'],
      ['G A', 'Agent comments'],
      ['⌘I', 'Agent comments drawer: j k move, d remove, ⇧X clear, t target, ⌘↵ send'],
      ['⌘G', 'Leader from anywhere, also inside terminals'],
      ['⌘,', 'Settings'],
      ['⌃- ⌃⇧-', 'Back or forward to the tab, worktree, file and line you were on']
    ] satisfies KeyHint[]
  ).map(([keys, label]) => ({ keys, label, section: 'Go to' })),
  ...(
    [
      ['F6', 'Next zone'],
      ['⇧F6', 'Previous zone'],
      ['⌃`', 'Next zone, alternative to F6'],
      ['j k', 'Move down / up in a list (arrows work too)'],
      ['⏎', 'Open or activate'],
      ['esc', 'Back one level: detail to list, input to zone'],
      ['?', 'This sheet, also ⌘/']
    ] satisfies KeyHint[]
  ).map(([keys, label]) => ({ keys, label, section: 'Focus' })),
  ...(
    [
      ['⌘⇧E', 'List'],
      ['⌘B', 'List, alias'],
      ['⌘⌥B', 'Inspector'],
      ['⌘J', 'Bottom terminal'],
      ['⌘⌥R', 'Workspace rail'],
      ['⌘⌥T', 'Title bar'],
      ['⌘⌥S', 'Status bar'],
      ['⌘⇧↵', 'Zen: only the main zone']
    ] satisfies KeyHint[]
  ).map(([keys, label]) => ({ keys, label, section: 'Panels' })),
  ...(
    [
      ['n p', 'Next or previous changed file'],
      ['j k', 'Move the line cursor in the diff'],
      ['c a', 'Agent comment on the line'],
      ['o ⏎', 'Open the file at the line to edit'],
      ['esc', 'Back from the file to its diff'],
      ['y', 'Copy the file or worktree path'],
      ['w', 'Split or unified diff'],
      ['m', 'Markdown preview'],
      ['h', 'Edit history of the open file'],
      ['t', 'Terminal in the worktree'],
      ['n', 'New worktree, in the list'],
      ['f', 'Focus on the project, in the list'],
      ['h l', 'Fold or unfold, in the list and explorer'],
      ['z', 'Fold or unfold all, in the list, changed files and explorer'],
      ['/', 'Filter the list or explorer'],
      ['r', 'Rescan worktrees'],
      ['⌘E', 'Changed files column'],
      ['⌘P', 'Find a file in the explorer'],
      ['⌘⇧F', 'Search across projects in scope']
    ] satisfies KeyHint[]
  ).map(([keys, label]) => ({ keys, label, section: 'Worktrees', page: 'worktrees' })),
  ...(
    [
      ['⌥⌘= ⌥⌘- ⌥⌘0', 'Bigger, smaller or default font in the focused terminal, else the editor (⌘= and ⌘- zoom the window)'],
      ['Hotkey', 'Show or hide the hotkey window from any app, recorded in Hotkey window'],
      ['esc', 'Close dialog or cancel comment']
    ] satisfies KeyHint[]
  ).map(([keys, label]) => ({ keys, label, section: 'General' })),
  ...(
    [
      ['⌘click', 'Go to definition, or references when on the definition'],
      ['F12', 'Definition, type definition, implementations, references; recorded in Code navigation'],
      ['Hover', 'Type and docs; dotted underline marks a navigable symbol'],
      ['Right-click', 'All navigation actions for the symbol']
    ] satisfies KeyHint[]
  ).map(([keys, label]) => ({ keys, label, section: 'Code navigation' })),
  ...(
    [
      ['Drag', 'Comment on a range of lines'],
      ['⌘↵', 'Save comment'],
      ['⌘V', 'Paste an image or file as an attachment']
    ] satisfies KeyHint[]
  ).map(([keys, label]) => ({ keys, label, section: 'Comments' }))
]

/** Every shortcut, the app's and those of enabled plugins, grouped by section in first-seen order */
export function useShortcuts(): [section: string, shortcuts: ShortcutInfo[]][] {
  const { loaded } = usePlugins()
  const { digitShortcuts } = useSettings()
  const digits = (target: 'tabs' | 'workspaces', label: string): ShortcutInfo[] =>
    digitShortcuts[target] === 'off' ? [] : [{ keys: `${DIGIT_MODIFIERS[digitShortcuts[target]]}1-9`, label, section: 'Go to' }]
  const all = [
    ...CORE_SHORTCUTS,
    ...digits('tabs', 'Title bar page by position, 9 is the last'),
    ...digits('workspaces', 'Workspace by rail order'),
    ...loaded.flatMap(({ plugin }) => plugin.shortcuts ?? [])
  ]
  const sections = [...new Set(all.map((shortcut) => shortcut.section))]
  return sections.map((section) => [section, all.filter((shortcut) => shortcut.section === section)])
}

type ShellKeys = {
  /** False while a dialog like the palette has the keyboard */
  enabled: boolean
  /** The key pressed after the leader */
  onLeader: (event: KeyboardEvent) => void
  onTogglePanel: (panel: 'list' | 'inspector' | 'rail' | 'title' | 'status') => void
  onSheet: () => void
}

/** ⌘ chords the shell owns; caught before the focused element, so they work inside terminals and the editor too */
export function useShellKeys(options: ShellKeys): void {
  const latest = useRef(options)
  latest.current = options
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.isComposing || getShell().recording) return
      const { enabled, onLeader, onTogglePanel, onSheet } = latest.current
      if (getShell().leader) {
        if (['Meta', 'Shift', 'Alt', 'Control'].includes(event.key)) return
        event.preventDefault()
        event.stopPropagation()
        updateShell({ leader: false })
        if (event.key !== 'Escape') onLeader(event)
        return
      }
      if (!enabled) return
      const { metaKey: meta, altKey: alt, shiftKey: shift, ctrlKey: ctrl, code } = event
      const action =
        meta && !ctrl && !alt && !shift && code === 'KeyG' ? () => updateShell({ leader: true })
        : meta && !ctrl && !alt && ((shift && code === 'KeyE') || (!shift && code === 'KeyB')) ? () => onTogglePanel('list')
        : meta && alt && !ctrl && !shift && code === 'KeyB' ? () => onTogglePanel('inspector')
        : meta && alt && !ctrl && !shift && code === 'KeyR' ? () => onTogglePanel('rail')
        : meta && alt && !ctrl && !shift && code === 'KeyT' ? () => onTogglePanel('title')
        : meta && alt && !ctrl && !shift && code === 'KeyS' ? () => onTogglePanel('status')
        // Composers take ⌘⇧↵ for their second action
        : meta && shift && !ctrl && !alt && code === 'Enter' && !isTyping(event) ? toggleZen
        : meta && !ctrl && !alt && code === 'Slash' && !isTyping(event) ? onSheet
        : !meta && !ctrl && !alt && code === 'F6' ? () => cycleZone(shift ? -1 : 1)
        : ctrl && !meta && !alt && code === 'Backquote' ? () => cycleZone(shift ? -1 : 1)
        : null
      if (!action) return
      event.preventDefault()
      event.stopPropagation()
      action()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}

/** Whether keyboard focus is in a terminal, where bare keys are typed rather than acted on */
function useTerminalFocused(): boolean {
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    const update = (): void => setFocused(document.activeElement?.closest('[data-session-id]') != null)
    window.addEventListener('focusin', update)
    window.addEventListener('focusout', update)
    return () => {
      window.removeEventListener('focusin', update)
      window.removeEventListener('focusout', update)
    }
  }, [])
  return focused
}

const DEFAULT_HINTS: Record<ZoneId, KeyHint[]> = {
  rail: [['j k', 'move'], ['⏎', 'open'], ['esc', 'back']],
  list: [['j k', 'move'], ['⏎', 'open']],
  main: [['esc', 'back']],
  inspector: [['esc', 'back']],
  dock: [['esc', 'back']]
}

/** Where you are and what the keys do there: workspace, page, focused zone and its key hints */
export function StatusBar({ workspace, pageLabel }: { workspace: { name: string; color?: string }; pageLabel: string }): React.JSX.Element {
  const { zone, label } = useZone()
  const { hints } = useShell()
  const terminal = useTerminalFocused()
  const shown: KeyHint[] = terminal ? [['⌘T', 'new tab'], ['⌘D', 'split'], ['⌥1-9', 'pane'], ['⌘W', 'close'], ['⌘G', 'go to'], ['F6', 'leave terminal']] : [...hints, ...DEFAULT_HINTS[zone]]
  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 overflow-hidden border-t border-border bg-card px-2 text-[11px] text-muted-foreground">
      <span className="flex shrink-0 items-center gap-1.5 text-foreground/80">
        <span className="size-2 rounded-[3px] bg-foreground/30" style={workspace.color ? { background: workspace.color } : undefined} />
        {workspace.name}
      </span>
      <span className="text-muted-foreground/40">/</span>
      <span className="shrink-0">{pageLabel}</span>
      <span className="shrink-0 rounded bg-foreground/[.08] px-1.5 text-[10.5px] font-medium text-foreground">{terminal ? 'Terminal input' : label}</span>
      <span className="flex min-w-0 items-center gap-3 overflow-hidden">
        {shown.slice(0, 7).map((hint) => (
          <KeyHintLabel key={hint.join(':')} hint={hint} />
        ))}
      </span>
    </footer>
  )
}

/** The leader's menu, while G waits for the next key */
export function WhichKey({ pages, workspaces }: { pages: { letter: string; label: string; icon: IconName }[]; workspaces: string[] }): React.JSX.Element | null {
  const { leader } = useShell()
  if (!leader) return null
  const item = (key: string, label: string, icon?: IconName): React.JSX.Element => (
    <div key={key} className="flex h-7 items-center gap-2 rounded px-2 text-xs">
      <Keys combo={key} on />
      {icon && <Icon name={icon} className="size-3.5 text-muted-foreground" />}
      <span className="truncate">{label}</span>
    </div>
  )
  return (
    <>
      {/* A click anywhere cancels the leader, even over a terminal that would swallow it */}
      <div className="fixed inset-0 z-[69]" onMouseDown={() => updateShell({ leader: false })} />
      <div className="fixed bottom-8 left-16 z-[70] max-h-[calc(100vh-4rem)] w-[440px] max-w-[calc(100vw-5rem)] overflow-y-auto rounded-lg border border-input bg-popover p-3 shadow-2xl shadow-black/60">
      <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
        <Keys combo="G" />
        <span className="font-medium text-foreground">Go to</span>
        <span className="flex-1" />
        <KeyHintLabel hint={['esc', 'cancel']} />
      </div>
      <div className="grid grid-cols-2 gap-x-3">
        {pages.map((page) => item(page.letter.toUpperCase(), page.label, page.icon))}
        {workspaces.slice(0, 9).map((name, index) => item(String(index + 1), `Workspace ${name}`))}
        {item('H', 'Recently closed sessions', 'history')}
        {item('A', 'Agent comments', 'comment')}
      </div>
      </div>
    </>
  )
}

/** ? or ⌘/: every shortcut at once; closing puts focus back where it was */
export function ShortcutSheet({ onClose }: { onClose: () => void }): React.JSX.Element {
  const sections = useShortcuts()
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // Keys stay with the sheet, not the list behind it
    const onKey = (event: KeyboardEvent): void => {
      event.stopPropagation()
      if (event.key !== 'Escape' && event.key !== '?') return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      previous?.focus({ preventScroll: true })
    }
  }, [])
  return (
    <div onClick={(event) => event.target === event.currentTarget && onClose()} className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50">
      <div className="flex max-h-[86vh] w-[1040px] max-w-[94vw] flex-col rounded-xl border border-input bg-popover shadow-2xl shadow-black/60">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
          <span className="text-[13px] font-medium">Keyboard</span>
          <span className="truncate text-xs text-muted-foreground">Chords with ⌘ work everywhere, single letters work outside text fields and the terminal.</span>
          <span className="flex-1" />
          <Keys combo="?" />
          <Keys combo="esc" />
        </div>
        <div className="min-h-0 flex-1 columns-3 gap-6 overflow-y-auto p-4">
          {sections.map(([section, shortcuts]) => (
            <div key={section} className="mb-4 break-inside-avoid">
              <div className="mb-1 text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase">{section}</div>
              {shortcuts.map((shortcut) => (
                <div key={`${shortcut.keys}:${shortcut.label}`} className="flex min-h-6 items-center gap-2 py-0.5 text-xs text-foreground/85">
                  <span className="flex-1">{shortcut.label}</span>
                  <Keys combo={shortcut.keys} />
                </div>
              ))}
            </div>
          ))}
          <div className="break-inside-avoid rounded-md border border-border p-2.5 text-[11px] leading-4 text-muted-foreground">
            <b className="text-foreground/80">Model.</b> Zones are rail, list, main, inspector and bottom terminal. F6 cycles them, the focused one has a frame. Inside a zone j k move a cursor, ⏎ acts,
            esc steps back. Terminals keep every bare key, so from a terminal use chords, ⌘G or F6.
          </div>
        </div>
      </div>
    </div>
  )
}
