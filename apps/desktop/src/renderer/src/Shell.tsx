import { useEffect, useRef, useState } from 'react'
import { cycleZone, getShell, isTyping, type KeyHint, KeyHintLabel, Keys, type ShortcutInfo, toggleZen, updateShell, useShell, useZone, type ZoneId } from '@treeix/sdk'
import { actionForEvent, actionKeys, actionList } from '../../shared/keymap'
import { registerActionRunner } from './actionRunners'
import { Icon, type IconName } from './Icon'
import { usePlugins } from './plugins'
import { DIGIT_MODIFIERS, useSettings } from './settings'

/** G then a letter goes to a page, by tab id; pages of plugins that are off are skipped */
export const LEADER_PAGES: Record<string, string> = { t: 'terminal', p: 'prs', w: 'worktrees', j: 'tasks', c: 'confluence', e: 'env', s: 'settings' }
export const leaderOf = (page: string): string | undefined => Object.keys(LEADER_PAGES).find((letter) => LEADER_PAGES[letter] === page)

/** Keys that aren't single actions: digit rows, the leader's letters, the focus model and what plugins list */
export function useKeyExtras(): ShortcutInfo[] {
  const { loaded } = usePlugins()
  const { digitShortcuts } = useSettings()
  const digits = (target: 'tabs' | 'workspaces', label: string): ShortcutInfo[] =>
    digitShortcuts[target] === 'off' ? [] : [{ keys: `${DIGIT_MODIFIERS[digitShortcuts[target]]}1-9`, label, section: 'Go to' }]
  return [
    ...digits('tabs', 'Title bar page by position, 9 is the last'),
    ...digits('workspaces', 'Workspace by rail order'),
    { keys: 'G then a letter', label: 'Pages: T terminal, P pull requests, W worktrees, J tasks, C Confluence, E env, S settings, H closed sessions, A agent comments', section: 'Go to' },
    { keys: 'j k ⏎ esc', label: 'Move in a list, open, step back: the focus model, fixed', section: 'Focus' },
    ...loaded.flatMap(({ plugin }) => plugin.shortcuts ?? [])
  ]
}

/** Every key the app answers to: the actions in the keymap and the fixed ones beside them, grouped by section */
export function useShortcuts(): [section: string, shortcuts: ShortcutInfo[]][] {
  const extras = useKeyExtras()
  const all: ShortcutInfo[] = [...actionList().map(({ id, label, section, page }) => ({ keys: actionKeys(id) || 'unbound', label, section, page })), ...extras]
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

/** The shell's actions, keyed by id; the key handler and the native menu both run them from here */
const shellActions = (latest: React.RefObject<ShellKeys>): Record<string, () => void> => ({
  'panel.list': () => latest.current.onTogglePanel('list'),
  'panel.inspector': () => latest.current.onTogglePanel('inspector'),
  'panel.rail': () => latest.current.onTogglePanel('rail'),
  'panel.title': () => latest.current.onTogglePanel('title'),
  'panel.status': () => latest.current.onTogglePanel('status'),
  'shell.zen': toggleZen,
  'app.shortcuts': () => latest.current.onSheet()
})

/** ⌘ chords the shell owns; caught before the focused element, so they work inside terminals and the editor too */
export function useShellKeys(options: ShellKeys): void {
  const latest = useRef(options)
  latest.current = options
  useEffect(() => {
    const drops = Object.entries(shellActions(latest)).map(([id, run]) => registerActionRunner(id, run))
    return () => drops.forEach((drop) => drop())
  }, [])
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
      // Every chord here is a named action, so Settings can rebind it
      const runs: Record<string, () => void> = {
        ...shellActions(latest),
        'app.leader': () => updateShell({ leader: true }),
        'panel.listAlt': () => onTogglePanel('list'),
        'app.shortcutsBare': onSheet,
        'zone.next': () => cycleZone(1),
        'zone.nextAlt': () => cycleZone(event.shiftKey ? -1 : 1),
        'zone.previous': () => cycleZone(-1)
      }
      // Composers own ⌘⇧↵ and text fields own the sheet keys; a terminal owns neither, so zen works from inside one
      const typing = isTyping(event)
      const live = Object.keys(runs).filter((id) => (id === 'shell.zen' ? !typing || terminalFocused() : id.startsWith('app.shortcuts') ? !typing : true))
      const id = actionForEvent(event, live)
      const action = id ? runs[id] : null
      if (!action) return
      event.preventDefault()
      event.stopPropagation()
      action()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}

const terminalFocused = (): boolean => document.activeElement?.closest('[data-session-id]') != null

/** Whether keyboard focus is in a terminal, where bare keys are typed rather than acted on */
function useTerminalFocused(): boolean {
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    const update = (): void => setFocused(terminalFocused())
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
  const hint = (id: string, label: string): KeyHint[] => (actionKeys(id) ? [[actionKeys(id), label] as KeyHint] : [])
  const shown: KeyHint[] = terminal
    ? [
        ...hint('terminal.newTab', 'new tab'),
        ...hint('terminal.splitRight', 'split'),
        ['⌥1-9', 'pane'],
        ['⌘W', 'close'],
        ...hint('shell.zen', 'zen'),
        ...hint('app.leader', 'go to'),
        ...hint('zone.next', 'leave terminal')
      ]
    : [...hints, ...DEFAULT_HINTS[zone]]
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
