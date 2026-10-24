import { useState, type KeyboardEvent } from 'react'
import { Icon } from '../lib/icons'
import { paletteResults, type Command, type Result } from '../lib/paletteSearch'
import { GROUP_COLORS, KIND_ICON, tabKind, tabTitle } from './model'
import { placeLabel } from './state'
import { keyHint, type CommandId } from './shortcuts'
import type { ShellView } from './Shell'
import { dialogCommands } from '../dialogs'
import { chatCommands } from '../panes/chat/open'
import { settingsNow } from '../features/agents/settings'
import { routineCommands } from '../features/routines'
import { browserCommands } from '../features/browser/open'
import { planCommands } from '../features/plans/open'
import { graphCommands } from '../features/graph/commands'
import { voiceCommands } from '../features/voice'

const ACTIONS: [CommandId, string][] = [
  ['new-shell', 'New shell here'],
  ['new-claude', 'New Claude Code here'],
  ['new-codex', 'New Codex here'],
  ['open-folder', 'Open folder...'],
  ['split-right', 'Split right'],
  ['split-down', 'Split down'],
  ['close-pane', 'Close pane'],
  ['reopen-tab', 'Reopen closed tab'],
  ['next-tab', 'Next tab'],
  ['prev-tab', 'Previous tab'],
  ['toggle-tabs', 'Toggle tabs: vertical or horizontal'],
  ['toggle-ui', 'Toggle layout: Compact or Islands'],
  ['toggle-theme', 'Toggle theme: dark or light'],
  ['toggle-sidebar', 'Toggle sidebar'],
  ['settings', 'Settings'],
  ['zoom-in', 'Zoom in'],
  ['zoom-out', 'Zoom out'],
  ['zoom-reset', 'Reset zoom'],
]

const ACTION_ICON: Partial<Record<CommandId, Command['icon']>> = {
  'new-shell': 'terminal',
  'new-claude': 'claude',
  'new-codex': 'codex',
  'open-folder': 'folder',
  'split-right': 'split',
  'split-down': 'splitDown',
  'close-pane': 'x',
  'reopen-tab': 'clock',
  'next-tab': 'right',
  'prev-tab': 'left',
  'toggle-tabs': 'layout',
  'toggle-ui': 'layout',
  'toggle-sidebar': 'sideL',
  settings: 'gear',
}

function commands(view: ShellView): Command[] {
  const actions = ACTIONS.map(([id, label]): Command => ({ id, group: 'Actions', label, shortcut: keyHint(id), icon: id === 'toggle-theme' ? (view.ui.theme === 'dark' ? 'sun' : 'moon') : ACTION_ICON[id], run: () => view.run(id) }))
  const tabs = view.ordered.map(
    (tab): Command => ({
      id: tab.id,
      group: 'Sessions',
      label: tabTitle(tab, view.sessions),
      detail: placeLabel(view.placeOfTab(tab)),
      icon: KIND_ICON[tabKind(tab, view.sessions)],
      run: () => view.dispatch({ type: 'activate', tabId: tab.id }),
    })
  )
  const focused = view.activeTab ? view.sessions[view.activeTab.focus] : undefined
  const features = settingsNow()?.features
  const chats = features?.chat ? chatCommands(view, focused?.cwd ?? view.home, focused) : []
  const phase67 = [
    ...(features?.routines ? routineCommands(view) : []),
    ...(features?.browser ? browserCommands(view) : []),
    ...(features?.plans ? planCommands(view) : []),
    ...(features?.graph ? graphCommands(view) : []),
    ...(features?.recording ? voiceCommands(view) : []),
  ]
  const place = view.activeTab && view.placeOfTab(view.activeTab)
  const colors = place
    ? GROUP_COLORS.map(([name, color]): Command => ({ id: `color-${name}`, group: 'Actions', label: `Group color: ${name}`, detail: placeLabel(place), run: () => view.dispatch({ type: 'color', key: place.key, color }) }))
    : []
  return [...actions, ...chats, ...phase67, ...dialogCommands(view), ...colors, ...tabs]
}

const Marked = ({ text, marks }: { text: string; marks: Set<number> }) => <>{[...text].map((ch, i) => (marks.has(i) ? <mark key={i}>{ch}</mark> : ch))}</>

export function Palette({ view, onClose }: { view: ShellView; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const results = paletteResults(commands(view), query)
  const current = Math.min(selected, results.length - 1)
  // Read at first render, before the input's autoFocus moves it
  const [opener] = useState(() => document.activeElement)
  const dismiss = () => {
    onClose()
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
  }

  // Focus goes back first, so a dialog the command opens returns it there too
  const pick = (result: Result | undefined) => {
    if (!result) return
    dismiss()
    result.command.run()
  }

  // Tab stays put: the input is the palette's only stop, arrows move through the list
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') dismiss()
    else if (e.key === 'Enter') pick(results[current])
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') setSelected((current + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % Math.max(results.length, 1))
    else if (e.key !== 'Tab') return
    e.preventDefault()
  }

  return (
    <>
      <div className="scrim" onMouseDown={dismiss} />
      <div className="palette" role="dialog">
        <label className="pin">
          <Icon name="search" />
          <input
            autoFocus
            value={query}
            placeholder="Search sessions and commands"
            onChange={(e) => {
              setQuery(e.target.value)
              setSelected(0)
            }}
            onKeyDown={onKeyDown}
          />
        </label>
        <div className="plist">
          {results.length === 0 && <div className="empty">No matches</div>}
          {results.map((result, i) => (
            <div key={result.command.id}>
              {result.command.group !== results[i - 1]?.command.group && <div className="mlabel">{result.command.group}</div>}
              <button className={`mi ${i === current ? 'on' : ''}`} onMouseMove={() => setSelected(i)} onClick={() => pick(result)}>
                {result.command.icon && (
                  <span className={`ki sm ${result.command.icon}`}>
                    <Icon name={result.command.icon} />
                  </span>
                )}
                <span className="trunc">
                  <Marked text={result.command.label} marks={result.marks} />
                </span>
                {result.command.detail && <span className="d">{result.command.detail}</span>}
                {result.command.shortcut && <kbd>{result.command.shortcut}</kbd>}
              </button>
            </div>
          ))}
        </div>
        <div className="pft">
          <span>↑↓ to move</span>
          <span>↵ to run</span>
          <span>esc to close</span>
          <span className="grow" />
          <span>&gt; actions</span>
          <span>@ sessions</span>
        </div>
      </div>
    </>
  )
}
