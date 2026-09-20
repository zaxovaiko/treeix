import { type ComponentType, useEffect, useRef, useState } from 'react'
import { focusZone, getShell, isTyping, ListToggle, PageLayout, updateShell, usePanels, useListNav } from '@treeix/sdk'
import type { ToolStatus } from '../../shared/types'
import { Icon, type IconName } from './Icon'
import { isModifierCode, type Shortcut, shortcutLabel } from '../../shared/shortcut'
import { type ActionDef, actionList, actionOf, conflictsOf, isRebound, shortcutOf } from '../../shared/keymap'
import { NAVIGATION_ACTIONS } from './codeNavigation'
import { BORDER_STRENGTHS, clampOpacity, DIGIT_MODIFIERS, type DigitModifier, type DigitTarget, FONT_SIZE_RANGE, fontStack, getSettings, MIN_OPACITY, type Settings, SYSTEM_FONTS, updateSettings, useSettings } from './settings'
import { type Agent, useAgents } from './agents'
import { type Theme, THEMES, type ThemeId } from './themes'
import { EmptyState, Popup } from './ui'
import { Card, HIDE_WHEN_EMPTY, Row, SearchGroup, Segmented, SETTING_ROW, settingMatches, SettingsSearch, Switch, useSettingMatch, useSettingsQuery } from './settingsUi'
import { isPluginEnabled, PLUGINS, setPluginEnabled, usePlugins, useService } from './plugins'
import { copyText } from './contextMenu'
import { useKeyExtras, useShortcuts } from './Shell'
import { checkForUpdates, updateSummary, useUpdates } from './updates'

export type SectionId = 'General' | 'Appearance' | 'Terminal' | 'Keyboard' | 'Plugins' | 'Integrations'
const SECTIONS: [SectionId, IconName][] = [
  ['General', 'settings'],
  ['Appearance', 'palette'],
  ['Terminal', 'terminal'],
  ['Keyboard', 'keyboard'],
  ['Plugins', 'plug'],
  ['Integrations', 'cloudCheck']
]

/** Click or ⏎, then press the combination; Esc cancels. Bare keys like § or F12 are allowed. */
function ShortcutRecorder({ value, onChange }: { value: Shortcut | null; onChange: (shortcut: Shortcut | null) => void }): React.JSX.Element {
  const [recording, setRecording] = useState(false)

  useEffect(() => {
    if (!recording) return
    // The current global hotkey would fire instead of being recorded
    window.api.configureHotkey({ shortcut: null, hideOnBlur: false, only: getSettings().hotkeyOnly })
    updateShell({ recording: true })
    const capture = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopImmediatePropagation()
      if (isModifierCode(event.code)) return
      const plain = !event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey
      if (plain && event.code === 'Escape') {
        setRecording(false)
        onChange(value)
        return
      }
      setRecording(false)
      onChange({ code: event.code, meta: event.metaKey, alt: event.altKey, ctrl: event.ctrlKey, shift: event.shiftKey })
    }
    window.addEventListener('keydown', capture, true)
    return () => {
      window.removeEventListener('keydown', capture, true)
      updateShell({ recording: false })
      const { hotkey, hotkeyHideOnBlur, hotkeyOnly } = getSettings()
      window.api.configureHotkey({ shortcut: hotkey, hideOnBlur: hotkeyHideOnBlur, only: hotkeyOnly && hotkey !== null })
    }
  }, [recording])

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <button
        onClick={() => {
          // Clicking again cancels; re-saving the old value registers it again
          if (recording) onChange(value)
          setRecording(!recording)
        }}
        className={`flex h-8 min-w-36 items-center justify-center rounded-lg px-3 font-mono text-[13px] ring-1 ${
          recording ? 'bg-foreground/[.08] text-foreground ring-input' : value ? 'text-foreground ring-border hover:bg-accent' : 'text-muted-foreground ring-border hover:bg-accent'
        }`}
      >
        {recording ? 'Press keys, esc cancels' : value ? shortcutLabel(value) : 'Record shortcut'}
      </button>
      {value && !recording && (
        <button title="Turn off" onClick={() => onChange(null)} className="grid size-8 place-items-center rounded-lg text-muted-foreground ring-1 ring-border hover:text-foreground">
          <Icon name="close" className="size-3.5" />
        </button>
      )}
    </div>
  )
}

function GlobalShortcut(): React.JSX.Element {
  const { hotkey, hotkeyHideOnBlur, hotkeyOnly } = useSettings()
  const [error, setError] = useState<string | null>(null)
  // main.tsx registers every change too; this call is only for the error to show here
  useEffect(() => {
    window.api.configureHotkey({ shortcut: hotkey, hideOnBlur: hotkeyHideOnBlur, only: hotkeyOnly && hotkey !== null }).then(setError)
  }, [hotkey, hotkeyHideOnBlur, hotkeyOnly])
  return (
    <div className="flex shrink-0 flex-col items-end gap-1.5">
      <ShortcutRecorder value={hotkey} onChange={(next) => updateSettings({ hotkey: next })} />
      {error && <span className="max-w-72 text-right text-[11px] break-words text-amber-400">{error}</span>}
    </div>
  )
}

function FontSize({ value, fallback, label, onChange }: { value: number; fallback: number; label: string; onChange: (size: number) => void }): React.JSX.Element {
  const step = (delta: number): void => onChange(Math.min(FONT_SIZE_RANGE.max, Math.max(FONT_SIZE_RANGE.min, value + delta)))
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-muted p-1 ring-1 ring-border">
      <button onClick={() => step(-1)} disabled={value <= FONT_SIZE_RANGE.min} aria-label={`Smaller ${label}`} className="h-6 w-7 rounded-md text-sm text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40">
        −
      </button>
      <span className="w-12 text-center text-xs tabular-nums">{value}px</span>
      <button onClick={() => step(1)} disabled={value >= FONT_SIZE_RANGE.max} aria-label={`Larger ${label}`} className="h-6 w-7 rounded-md text-sm text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40">
        +
      </button>
      <button onClick={() => onChange(fallback)} disabled={value === fallback} title="Reset" className="grid h-6 w-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-0">
        <Icon name="refresh" className="size-3" />
      </button>
    </div>
  )
}

type LocalFontData = { family: string }
type FontAccess = Window & { queryLocalFonts: () => Promise<LocalFontData[]> }
const hasFontAccess = (candidate: Window): candidate is FontAccess => 'queryLocalFonts' in candidate

type FontFamily = { name: string; monospace: boolean; label?: string }
let installedFonts: Promise<FontFamily[]> | null = null

/** Installed families, flagged monospace when narrow and wide glyphs measure the same */
function loadInstalledFonts(): Promise<FontFamily[]> {
  if (!hasFontAccess(window)) return Promise.resolve([])
  installedFonts ??= window.queryLocalFonts().then((fonts) => {
    const context = document.createElement('canvas').getContext('2d')
    const names = [...new Set(fonts.map((font) => font.family))].sort((a, b) => a.localeCompare(b))
    return names.map((name) => {
      if (!context) return { name, monospace: false }
      context.font = `16px "${name}"`
      return { name, monospace: context.measureText('iiiiiiiiii').width === context.measureText('WWWWWWWWWW').width }
    })
  })
  // A refused prompt is retried on the next focus instead of caching an empty list
  installedFonts.catch(() => (installedFonts = null))
  return installedFonts.catch(() => [])
}

const MAX_FONT_SUGGESTIONS = 80

/** Free-text family name with installed fonts suggested, each previewed in itself; ↑ ↓ pick one */
function FontPicker({ value, monospace, onChange }: { value: string; monospace: boolean; onChange: (family: string) => void }): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  const [fonts, setFonts] = useState<FontFamily[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => setDraft(value), [value])
  useEffect(() => listRef.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' }), [active])
  const needle = draft.trim().toLowerCase()
  const exact = fonts.some((font) => font.name.toLowerCase() === needle)
  const system = SYSTEM_FONTS.filter((font) => font.monospace === monospace).map(({ value, label }) => ({ name: value, label, monospace }))
  const suggestions = [...system, ...fonts]
    .filter((font) => (!monospace || font.monospace) && (exact || !needle || `${font.name} ${font.label ?? ''}`.toLowerCase().includes(needle)))
    .slice(0, MAX_FONT_SUGGESTIONS)
  const commit = (family: string): void => {
    setDraft(family)
    setOpen(false)
    setActive(-1)
    if (family.trim() !== value) onChange(family.trim())
  }
  return (
    <div className="relative w-56 max-w-full shrink-0">
      <input
        ref={inputRef}
        value={draft}
        spellCheck={false}
        placeholder="Default"
        onFocus={() => {
          setOpen(true)
          // Font access needs a user gesture the first time, which focusing the field provides
          void loadInstalledFonts().then(setFonts)
        }}
        onChange={(event) => {
          setDraft(event.target.value)
          setOpen(true)
          setActive(-1)
        }}
        onBlur={() => commit(draft)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            const step = event.key === 'ArrowDown' ? 1 : -1
            setOpen(true)
            setActive(Math.min(suggestions.length - 1, Math.max(0, active + step)))
          }
          if (event.key === 'Enter') {
            const picked = suggestions[active]
            if (picked) commit(picked.name)
            event.currentTarget.blur()
          }
          // Esc first closes the suggestions, then hands the keys back to the row
          if (event.key === 'Escape' && (open || draft !== value)) {
            event.stopPropagation()
            setDraft(value)
            setOpen(false)
            setActive(-1)
          }
        }}
        style={{ fontFamily: draft.trim() ? fontStack(draft, 'sans-serif') : undefined }}
        className="h-8 w-full rounded-md border border-input bg-muted px-2.5 pr-7 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70"
      />
      {value && (
        <button onMouseDown={(event) => event.preventDefault()} onClick={() => commit('')} title="Use default" className="absolute top-2 right-2 text-muted-foreground hover:text-foreground">
          <Icon name="close" className="size-3.5" />
        </button>
      )}
      {open && suggestions.length > 0 && (
        <Popup ref={listRef} anchor={inputRef} align="stretch" className="max-h-64 overflow-y-auto rounded-lg border border-input bg-popover p-1">
          {suggestions.map((font, index) => (
            <button
              key={font.name}
              tabIndex={-1}
              data-active={index === active ? '' : undefined}
              // mousedown keeps focus in the input, so blur doesn't commit the typed text first
              onMouseDown={(event) => {
                event.preventDefault()
                commit(font.name)
              }}
              className={`flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-foreground/85 hover:bg-accent ${index === active ? 'bg-accent' : ''}`}
            >
              {/* Names in the UI font stay readable for symbol fonts; the sample shows the face itself */}
              <span className="min-w-0 flex-1 truncate">{font.label ?? font.name}</span>
              <span style={{ fontFamily: fontStack(font.name, 'sans-serif') }} className="shrink-0 text-muted-foreground">
                Aa 0O
              </span>
              {font.name === value && <Icon name="check" className="size-3 shrink-0 text-foreground" />}
            </button>
          ))}
        </Popup>
      )}
    </div>
  )
}

const DIGIT_TARGETS: { target: DigitTarget; label: string; description: string }[] = [
  { target: 'tabs', label: 'Tabs', description: 'Title bar pages, then open PR and plan tabs; 9 is the last tab. Off by default: G and a letter goes to a page from anywhere.' },
  { target: 'workspaces', label: 'Workspaces', description: 'Workspaces in rail order, like G and a number. ⌃ digits also switch macOS desktops.' }
]

type SettingSpec = {
  section: SectionId
  card: string
  label: string
  description: string
  Control: ComponentType
  /** Appended to the description while it applies, like a clash with another row */
  note?: (settings: Settings) => string
}

function segmented<K extends 'diffStyle' | 'sections' | 'bottomPanel'>(key: K, options: [Settings[K], string][]): ComponentType {
  return function SettingSegmented() {
    const value = useSettings()[key]
    return <Segmented value={value} options={options} onChange={(next) => updateSettings({ [key]: next })} />
  }
}

function toggle(key: 'sidebarBranches' | 'hotkeyHideOnBlur' | 'hotkeyOnly', label: string): ComponentType {
  return function SettingSwitch() {
    const value = useSettings()[key]
    return <Switch checked={value} label={label} onChange={() => updateSettings({ [key]: !value })} />
  }
}

function fontRow(key: 'uiFont' | 'editorFont' | 'terminalFont', size?: { key: 'editorFontSize' | 'terminalFontSize'; fallback: number; label: string }): ComponentType {
  return function FontControl() {
    const settings = useSettings()
    const picker = <FontPicker value={settings[key]} monospace={key !== 'uiFont'} onChange={(family) => updateSettings({ [key]: family })} />
    if (!size) return picker
    return (
      <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">
        {picker}
        <FontSize label={size.label} value={settings[size.key]} fallback={size.fallback} onChange={(next) => updateSettings({ [size.key]: next })} />
      </div>
    )
  }
}

function Transparency(): React.JSX.Element {
  const { opacity } = useSettings()
  return (
    <div className="flex w-56 max-w-full shrink-0 items-center gap-3">
      <input
        type="range"
        min={MIN_OPACITY}
        max={100}
        value={opacity}
        aria-label="Window opacity"
        onChange={(event) => updateSettings({ opacity: clampOpacity(Number(event.target.value)) })}
        style={{ background: `linear-gradient(to right, var(--color-primary) ${((opacity - MIN_OPACITY) / (100 - MIN_OPACITY)) * 100}%, color-mix(in srgb, var(--color-foreground) 12%, transparent) 0)` }}
        className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full [&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow"
      />
      <span className="w-10 text-right text-xs text-muted-foreground tabular-nums">{100 - opacity}%</span>
    </div>
  )
}

/** Version, what the updater is doing, and the button that acts on it */
function UpdateControl(): React.JSX.Element {
  const status = useUpdates()
  const [checking, setChecking] = useState(false)
  const busy = checking || status.phase === 'checking' || status.phase === 'downloading'
  const check = (): void => {
    setChecking(true)
    void checkForUpdates().finally(() => setChecking(false))
  }
  if (status.phase === 'ready') {
    return (
      <button onClick={() => window.api.updates.install()} className="h-7 shrink-0 rounded-md bg-foreground/10 px-2.5 text-xs font-medium text-foreground ring-1 ring-border hover:bg-accent">
        Restart and install {status.version}
      </button>
    )
  }
  return (
    <button
      onClick={check}
      disabled={busy || status.phase === 'unsupported'}
      className="h-7 shrink-0 rounded-md px-2.5 text-xs text-foreground ring-1 ring-border hover:bg-accent disabled:text-muted-foreground disabled:hover:bg-transparent"
    >
      {busy ? 'Checking…' : 'Check for updates'}
    </button>
  )
}

/** Every setting with a row of its own; the command palette lists them too */
const SETTINGS: SettingSpec[] = [
  {
    section: 'General',
    card: 'Updates',
    label: 'Version',
    description: 'Treeix checks GitHub for a new build on launch and every few hours, downloads it in the background, and installs it when you restart.',
    Control: function Updates() {
      const status = useUpdates()
      return (
        <div className="flex min-w-0 items-center gap-3">
          <span className="truncate text-xs text-muted-foreground">{updateSummary(status)}</span>
          <UpdateControl />
        </div>
      )
    }
  },
  {
    section: 'General',
    card: 'Layout',
    label: 'Diff view',
    description: 'How diffs render in worktrees and pull requests. Also switchable from the diff header.',
    Control: segmented('diffStyle', [
      ['split', 'Split'],
      ['unified', 'Unified']
    ])
  },
  {
    section: 'General',
    card: 'Layout',
    label: 'Sections',
    description: 'Whether folder groups start expanded or hidden. Panels start open and remember when you close them.',
    Control: segmented('sections', [
      ['hidden', 'Hidden'],
      ['expanded', 'Expanded']
    ])
  },
  {
    section: 'General',
    card: 'Layout',
    label: 'Bottom panel',
    description: 'Whether a panel docked at the bottom, like the terminal, sits beside the sidebar or spans the full width under it. Applies to every tab.',
    Control: segmented('bottomPanel', [
      ['content', 'Beside sidebar'],
      ['full', 'Full width']
    ])
  },
  {
    section: 'General',
    card: 'Layout',
    label: 'Branches in sidebar',
    description: 'List branches that have no worktree under each project in the Worktrees sidebar.',
    Control: toggle('sidebarBranches', 'Branches in sidebar')
  },
  {
    section: 'General',
    card: 'Hotkey window',
    label: 'Global shortcut',
    description:
      'Drops Treeix over everything, full screen below the menu bar, from any app. Press again to hide. Any key works, including § on ISO keyboards; while it is set, that key opens Treeix instead of typing.',
    Control: GlobalShortcut
  },
  {
    section: 'General',
    card: 'Hotkey window',
    label: 'Hide when focus is lost',
    description: 'Clicking another app puts the hotkey window away, like iTerm2.',
    Control: toggle('hotkeyHideOnBlur', 'Hide when focus is lost')
  },
  {
    section: 'General',
    card: 'Hotkey window',
    label: 'Hotkey window only',
    description: 'No normal window: Treeix always stays the drop-down and only shows or hides, so nothing resizes or re-renders when it appears. Needs a global shortcut.',
    Control: toggle('hotkeyOnly', 'Hotkey window only')
  },
  {
    section: 'Appearance',
    card: 'Window',
    label: 'Transparency',
    description: 'Lets the blurred desktop show through backgrounds while text stays solid. Applies instantly.',
    Control: Transparency
  },
  {
    section: 'Appearance',
    card: 'Window',
    label: 'Borders',
    description: "How visible dividers and field outlines are, from none to the theme's full strength.",
    Control: function Borders() {
      const { borderStrength } = useSettings()
      return (
        <Segmented
          value={`${borderStrength}`}
          options={BORDER_STRENGTHS.map((strength): [string, string] => [`${strength}`, `${strength}%`])}
          onChange={(value) => updateSettings({ borderStrength: BORDER_STRENGTHS.find((strength) => `${strength}` === value) ?? 100 })}
        />
      )
    }
  },
  { section: 'Appearance', card: 'Fonts', label: 'Interface', description: "Menus, lists, markdown and everything that isn't code.", Control: fontRow('uiFont') },
  {
    section: 'Appearance',
    card: 'Fonts',
    label: 'Editor',
    description: 'Code in the editor, diffs and pull requests. Size is independent of window zoom (⌘+ / ⌘-).',
    Control: fontRow('editorFont', { key: 'editorFontSize', fallback: 13, label: 'editor font' })
  },
  {
    section: 'Terminal',
    card: 'Font',
    label: 'Terminal font',
    description: 'Terminal and agent sessions. Open terminals resize to fit; ⌥⌘= and ⌥⌘- change the size from a terminal.',
    Control: fontRow('terminalFont', { key: 'terminalFontSize', fallback: 12, label: 'terminal font' })
  },
  {
    section: 'Terminal',
    card: 'Performance',
    label: 'Scrollback',
    description: 'Lines each terminal keeps to scroll back through. More lines use more memory per session. Applies to open terminals too.',
    Control: function Scrollback() {
      const { terminalScrollback } = useSettings()
      const lines = ['1000', '3000', '5000', '10000', '20000'] as const
      return <Segmented value={`${terminalScrollback}`} options={lines.map((count) => [count, Number(count).toLocaleString('en-US')])} onChange={(count) => updateSettings({ terminalScrollback: Number(count) })} />
    }
  },
  {
    section: 'Terminal',
    card: 'Performance',
    label: 'Highlighting workers',
    description: 'Syntax highlighting of diffs and files. More workers highlight large diffs faster but each keeps its own grammars in memory. Applies after restart.',
    Control: function Workers() {
      const { highlightWorkers } = useSettings()
      const counts = ['1', '2', '3', '4'] as const
      return <Segmented value={`${highlightWorkers}`} options={counts.map((count) => [count, count])} onChange={(count) => updateSettings({ highlightWorkers: Number(count) })} />
    }
  },
  ...DIGIT_TARGETS.map(
    ({ target, label, description }): SettingSpec => ({
      section: 'Terminal',
      card: 'Number shortcuts',
      label,
      description,
      note: ({ digitShortcuts }) => {
        const modifier = digitShortcuts[target]
        const clash = modifier !== 'off' && DIGIT_TARGETS.some((other) => other.target !== target && digitShortcuts[other.target] === modifier)
        return clash ? ' Same modifier as another row, so only one of them works.' : ''
      },
      Control: function DigitModifierControl() {
        const { digitShortcuts } = useSettings()
        return (
          <Segmented
            value={digitShortcuts[target]}
            options={Object.entries(DIGIT_MODIFIERS).map(([id, name]) => [id as DigitModifier, name])}
            onChange={(next) => updateSettings({ digitShortcuts: { ...getSettings().digitShortcuts, [target]: next } })}
          />
        )
      }
    })
  ),
  ...NAVIGATION_ACTIONS.map(
    ({ kind, label, description }): SettingSpec => ({
      section: 'Keyboard',
      card: 'Code navigation',
      label,
      description,
      Control: function NavigationKey() {
        const { navigationKeys } = useSettings()
        return <ShortcutRecorder value={navigationKeys[kind]} onChange={(next) => updateSettings({ navigationKeys: { ...getSettings().navigationKeys, [kind]: next } })} />
      }
    })
  )
]

function SettingRow({ spec: { label, description, note, Control } }: { spec: SettingSpec }): React.JSX.Element {
  const settings = useSettings()
  return (
    <Row label={label} description={`${description}${note?.(settings) ?? ''}`}>
      <Control />
    </Row>
  )
}

function ThemePreview({ theme }: { theme: Theme }): React.JSX.Element {
  return (
    <div style={{ background: theme.background }} className="flex h-20 min-w-0 gap-2 p-2.5">
      <div style={{ background: theme.card }} className="flex w-1/3 flex-col gap-1.5 rounded p-1.5">
        <span style={{ background: theme.mutedForeground }} className="h-1 w-3/4 rounded-full opacity-60" />
        <span style={{ background: theme.primary }} className="h-1 w-1/2 rounded-full" />
        <span style={{ background: theme.mutedForeground }} className="h-1 w-2/3 rounded-full opacity-60" />
      </div>
      <div className="flex flex-1 flex-col gap-1.5 pt-1">
        <span style={{ background: theme.foreground }} className="h-1 w-4/5 rounded-full opacity-80" />
        <span className="h-1 w-3/5 rounded-full bg-emerald-400/70" />
        <span className="h-1 w-2/3 rounded-full bg-red-400/70" />
        <span style={{ background: theme.popover }} className="mt-auto h-3 w-1/2 rounded" />
      </div>
    </div>
  )
}

function ThemeCard({ label, selected, onSelect, children }: { label: string; selected: boolean; onSelect: () => void; children: React.ReactNode }): React.JSX.Element | null {
  if (!useSettingMatch(label, 'theme')) return null
  return (
    <button
      data-setting={label}
      onClick={onSelect}
      className={`min-w-0 overflow-hidden rounded-lg text-left ring-1 ${selected ? 'ring-input' : 'ring-border hover:ring-input'}`}
    >
      {children}
      <div className="flex items-center gap-2 bg-card px-2.5 py-2 text-xs">
        <span className="min-w-0 truncate">{label}</span>
        {selected && <Icon name="check" className="ml-auto size-3 shrink-0 text-foreground" />}
      </div>
    </button>
  )
}

function Themes(): React.JSX.Element {
  const { theme: current } = useSettings()
  return (
    <Card title="Theme">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3 p-4">
        <ThemeCard label="System" selected={current === 'system'} onSelect={() => updateSettings({ theme: 'system' })}>
          {/* Dark and light halves: the theme follows the macOS appearance */}
          <div className="grid h-20 grid-cols-2">
            <ThemePreview theme={THEMES.neutral} />
            <ThemePreview theme={THEMES.light} />
          </div>
        </ThemeCard>
        {(Object.keys(THEMES) as ThemeId[]).map((id) => (
          <ThemeCard key={id} label={THEMES[id].label} selected={current === id} onSelect={() => updateSettings({ theme: id })}>
            <ThemePreview theme={THEMES[id]} />
          </ThemeCard>
        ))}
      </div>
    </Card>
  )
}

function ShortcutRow({ keys, action }: { keys: string; action: string }): React.JSX.Element | null {
  if (!useSettingMatch(action, keys, 'shortcut')) return null
  return (
    <div data-setting={action} tabIndex={-1} className={`flex items-center gap-4 border-b border-border px-4 py-2.5 text-[13px] last:border-b-0 ${SETTING_ROW}`}>
      <span className="min-w-0 flex-1 break-words">{action}</span>
      <kbd className="max-w-[45%] shrink-0 rounded-md bg-muted px-2 py-0.5 text-right font-sans text-xs break-words text-muted-foreground ring-1 ring-border">{keys}</kbd>
    </div>
  )
}

/** One action: its key, recorded here or reset to the one it ships with */
function ActionRow({ action }: { action: ActionDef }): React.JSX.Element | null {
  const current = shortcutOf(action.id)
  const keys = current ? shortcutLabel(current) : ''
  const clash = conflictsOf(action.id)
    .map((id) => actionOf(id)?.label)
    .filter((label): label is string => label !== undefined)
  if (!useSettingMatch(action.label, keys, 'shortcut')) return null
  const rebind = (next: Shortcut | null): void => updateSettings({ keymap: { ...getSettings().keymap, [action.id]: next } })
  const reset = (): void => {
    const { [action.id]: _removed, ...rest } = getSettings().keymap
    updateSettings({ keymap: rest })
  }
  return (
    <div data-setting={action.label} tabIndex={-1} className={`flex items-center gap-3 border-b border-border px-4 py-2.5 text-[13px] last:border-b-0 ${SETTING_ROW}`}>
      <span className="min-w-0 flex-1 break-words">
        {action.label}
        {clash.length > 0 && <span className="block text-[11px] text-amber-400">Same key as {clash.join(', ')}</span>}
      </span>
      <ShortcutRecorder value={current} onChange={rebind} />
      {isRebound(action.id) && (
        <button onClick={reset} title="Back to the key it ships with" className="shrink-0 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
          Reset
        </button>
      )}
    </div>
  )
}

/** Every action with its key, rebindable; the fixed keys of the focus model and the digit rows follow them */
function Shortcuts(): React.JSX.Element {
  // Rebinding writes to settings, so this re-renders with the new keys
  useSettings()
  const actions = actionList()
  const sections = [...new Set(actions.map((action) => action.section))]
  const extras = useKeyExtras()
  const extraSections = [...new Set(extras.map((shortcut) => shortcut.section))]
  return (
    <>
      {sections.map((section) => (
        <Card key={section} title={`${section} shortcuts`}>
          {actions.filter((action) => action.section === section).map((action) => (
            <ActionRow key={action.id} action={action} />
          ))}
        </Card>
      ))}
      {extraSections.map((section) => (
        <Card key={`fixed:${section}`} title={`${section}: fixed keys`}>
          {extras.filter((shortcut) => shortcut.section === section).map(({ keys, label }) => (
            <ShortcutRow key={`${keys}:${label}`} keys={keys} action={label} />
          ))}
        </Card>
      ))}
    </>
  )
}

/** While searching, names the plugin above matching settings of its own whose switch row filtered out */
function PluginName({ name, description }: { name: string; description: string }): React.JSX.Element | null {
  const query = useSettingsQuery()
  return query && !settingMatches(query, name, description) ? <div className="px-4 pt-3 text-xs font-medium text-muted-foreground">{name}</div> : null
}

/** Everything beyond worktrees and diffs; each plugin's own settings show under its switch while it's on */
function Plugins(): React.JSX.Element {
  const settings = useSettings()
  const { loaded } = usePlugins()
  return (
    <Card title="Plugins">
      {PLUGINS.map(({ manifest }) => {
        const enabled = isPluginEnabled(manifest.id, settings.plugins)
        const chosen = settings.plugins[manifest.id] ?? manifest.enabledByDefault
        const missing = (manifest.requires ?? []).filter((id) => !isPluginEnabled(id, settings.plugins))
        const PluginSettings = loaded.find((entry) => entry.manifest.id === manifest.id)?.plugin.Settings
        const requirement = missing.length ? ` Needs ${missing.map((id) => PLUGINS.find((entry) => entry.manifest.id === id)?.manifest.name ?? id).join(', ')}.` : ''
        return (
          <SearchGroup key={manifest.id} title={`${manifest.name} ${manifest.description}`} className="border-b border-border last:border-b-0">
            <PluginName name={manifest.name} description={manifest.description} />
            <Row label={manifest.name} description={`${manifest.description}${chosen ? requirement : ''}`}>
              <Switch checked={chosen} label={manifest.name} onChange={() => setPluginEnabled(manifest.id, !chosen)} />
            </Row>
            {enabled && PluginSettings && (
              <div className="mx-3 mb-3 rounded-lg bg-muted/50 ring-1 ring-border">
                <PluginSettings />
              </div>
            )}
          </SearchGroup>
        )
      })}
    </Card>
  )
}

function ToolMark({ name }: { name: string }): React.JSX.Element | null {
  const Mark = usePlugins().loaded.find(({ plugin }) => plugin.toolMarks?.[name])?.plugin.toolMarks?.[name]
  return Mark ? <Mark /> : null
}

/** Time an update is given before the tools are checked again */
const UPDATE_SETTLE_MS = 30_000

/** Runs the update in a terminal session so its output and any password prompt are visible */
function UpdateButton({ command, onDone }: { command: string; onDone: () => Promise<void> }): React.JSX.Element {
  const sessions = useService('sessions')
  const [copied, setCopied] = useState(false)
  const [running, setRunning] = useState(false)
  if (!sessions) {
    return (
      <button
        title={command}
        onClick={() => {
          copyText(command)
          setCopied(true)
        }}
        className="h-6 max-w-full truncate rounded-md px-2 text-[11px] text-muted-foreground ring-1 ring-border hover:text-foreground"
      >
        {copied ? 'Command copied' : `Copy ${command}`}
      </button>
    )
  }
  return (
    <button
      title={running ? `${command} is running in a terminal session` : `Runs ${command} in a new terminal session`}
      disabled={running}
      onClick={() => {
        setRunning(true)
        void sessions.runCommand(window.api.home, command)
        // The check reruns once the update has had time to finish; watch the session for what it printed
        setTimeout(() => void onDone().finally(() => setRunning(false)), UPDATE_SETTLE_MS)
      }}
      className="flex h-6 items-center rounded-md bg-primary/15 px-2 text-[11px] font-medium text-primary ring-1 ring-primary/40 hover:bg-primary/25 disabled:opacity-70"
    >
      {running ? 'Updating…' : 'Update'}
    </button>
  )
}

function Tools(): React.JSX.Element {
  const [tools, setTools] = useState<ToolStatus[] | null>(null)
  const [checking, setChecking] = useState(false)

  const check = (): Promise<void> => {
    setChecking(true)
    return window.api
      .checkTools()
      .then(setTools)
      .finally(() => setChecking(false))
  }

  useEffect(() => void check(), [])

  return (
    <Card title="Command line tools">
      <Row label="Check again" description="Looks for the tools in your login shell again, after installing one or signing in.">
        <button disabled={checking} onClick={() => void check()} className="h-7 shrink-0 rounded-md px-2.5 text-xs text-muted-foreground ring-1 ring-border hover:text-foreground disabled:opacity-70">
          {checking ? 'Checking…' : 'Check'}
        </button>
      </Row>
      {!tools && <EmptyState title="Checking your login shell..." />}
      {tools?.map((tool) => (
        <ToolRow key={tool.name} tool={tool} check={check} />
      ))}
    </Card>
  )
}

function ToolRow({ tool, check }: { tool: ToolStatus; check: () => Promise<void> }): React.JSX.Element | null {
  if (!useSettingMatch(tool.name, tool.purpose)) return null
  return (
    <div data-setting={tool.name} tabIndex={-1} className={`flex items-start gap-3 border-b border-border px-4 py-3 last:border-b-0 ${SETTING_ROW}`}>
      <span className={`mt-1.5 size-2 shrink-0 rounded-full ${tool.error ? (tool.version ? 'bg-amber-400' : 'bg-red-400') : 'bg-emerald-400'}`} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 text-[13px]">
          <ToolMark name={tool.name} />
          <span className="font-mono">{tool.name}</span>
          <span className="min-w-0 text-xs break-words text-muted-foreground">{tool.purpose}</span>
        </div>
        {tool.version && <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{tool.version}</div>}
        {tool.update && (
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-sky-400">
            <span className="min-w-0 break-words select-text">Update available: {tool.update}</span>
            {tool.updateCommand && <UpdateButton command={tool.updateCommand} onDone={check} />}
          </div>
        )}
        {tool.accounts?.map((account) => (
          <div key={account} className="mt-0.5 truncate text-xs text-emerald-400">
            Signed in as {account}
          </div>
        ))}
        {tool.error && <div className="mt-0.5 text-xs break-words text-amber-400 select-text">{tool.error}</div>}
      </div>
    </div>
  )
}

/** The text fields of an Agent; `id` is generated and `agent` is not worth a switch until something needs it */
type AgentField = 'label' | 'command' | 'mark' | 'color' | 'promptFlag' | 'sessionIdFlag' | 'resumeCommand'

const AGENT_FIELDS: { key: AgentField; label: string; placeholder: string }[] = [
  { key: 'label', label: 'Name', placeholder: 'Aider' },
  { key: 'command', label: 'Command', placeholder: 'aider' },
  { key: 'mark', label: 'Badge', placeholder: 'A' },
  { key: 'color', label: 'Colour', placeholder: '#34d399' },
  { key: 'promptFlag', label: 'Prompt flag', placeholder: 'empty passes it as an argument' },
  { key: 'sessionIdFlag', label: 'Session id flag', placeholder: '--session-id' },
  { key: 'resumeCommand', label: 'Resume command', placeholder: 'aider --restore, {id} is the session id' }
]

function AgentRow({ agent, builtin }: { agent: Agent; builtin: boolean }): React.JSX.Element {
  const custom = useSettings().customAgents
  const write = (next: Agent[]): void => updateSettings({ customAgents: next })
  const edit = (key: AgentField, value: string): void =>
    write(custom.map((entry) => (entry.id === agent.id ? { ...entry, [key]: key === 'command' && !value ? null : value } : entry)))
  return (
    <SearchGroup title={`${agent.label} ${agent.command ?? ''}`} className="border-b border-border last:border-b-0">
      <Row label={agent.label} description={agent.command ?? 'Runs your login shell'}>
        {builtin ? (
          <button onClick={() => write([...custom, { ...agent }])} className="h-6 rounded-md px-2 text-[11px] text-muted-foreground ring-1 ring-border hover:text-foreground">
            Override
          </button>
        ) : (
          <button onClick={() => write(custom.filter((entry) => entry.id !== agent.id))} className="h-6 rounded-md px-2 text-[11px] text-muted-foreground ring-1 ring-border hover:text-red-400">
            Remove
          </button>
        )}
      </Row>
      {!builtin &&
        AGENT_FIELDS.map((field) => (
          <Row key={field.key} label={field.label} description="">
            <input
              value={String(agent[field.key] ?? '')}
              placeholder={field.placeholder}
              onChange={(event) => edit(field.key, event.target.value)}
              className="h-6 w-56 rounded-md bg-muted px-2 text-[11px] ring-1 ring-border"
            />
          </Row>
        ))}
    </SearchGroup>
  )
}

function Agents(): React.JSX.Element {
  const agents = useAgents()
  const custom = useSettings().customAgents
  const add = (): void => {
    // crypto.randomUUID over a counter: a counter derived from the current length repeats once an agent added earlier is removed
    const id = crypto.randomUUID()
    updateSettings({ customAgents: [...custom, { id, label: 'New agent', mark: '●', color: 'var(--color-foreground)', command: '', agent: true }] })
  }
  return (
    <Card title="Agents">
      {agents.map((agent) => (
        <AgentRow key={agent.id} agent={agent} builtin={!custom.some((entry) => entry.id === agent.id)} />
      ))}
      <Row label="Add an agent" description="Any CLI agent Treeix can start in a worktree. Override a built-in to change its command.">
        <button onClick={add} className="h-6 rounded-md px-2 text-[11px] text-muted-foreground ring-1 ring-border hover:text-foreground">
          Add
        </button>
      </Row>
    </Card>
  )
}

/** Blocks after a section's own rows */
const SECTION_EXTRAS: Partial<Record<SectionId, ComponentType>> = { Appearance: Themes, Terminal: Agents, Keyboard: Shortcuts, Plugins, Integrations: Tools }

function Section({ id }: { id: SectionId }): React.JSX.Element {
  const specs = SETTINGS.filter((spec) => spec.section === id)
  const Extra = SECTION_EXTRAS[id]
  return (
    <>
      {[...new Set(specs.map((spec) => spec.card))].map((card) => (
        <Card key={card} title={card}>
          {specs
            .filter((spec) => spec.card === card)
            .map((spec) => (
              <SettingRow key={spec.label} spec={spec} />
            ))}
        </Card>
      ))}
      {Extra && <Extra />}
    </>
  )
}

/** A setting the command palette points at: which section it's in, and its row or card label */
export type SettingEntry = { section: SectionId; card: string; label: string; keys?: string }

/** Everything in Settings the palette can jump to; plugins' own settings are found by searching Settings itself */
export function useSettingEntries(): SettingEntry[] {
  const shortcuts = useShortcuts()
  return [
    ...SETTINGS.map(({ section, card, label }) => ({ section, card, label })),
    { section: 'Appearance', card: 'Theme', label: 'Theme' },
    { section: 'Terminal', card: 'Agents', label: 'Agents' },
    ...PLUGINS.map(({ manifest }): SettingEntry => ({ section: 'Plugins', card: 'Plugins', label: manifest.name })),
    { section: 'Integrations', card: 'Command line tools', label: 'Command line tools' },
    ...shortcuts.flatMap(([card, list]) => list.map(({ keys, label }): SettingEntry => ({ section: 'Keyboard', card: `${card} shortcuts`, label, keys })))
  ]
}

let pendingReveal: SettingEntry | null = null
let onReveal: (() => void) | null = null

/** Shows the setting's section with keyboard focus on its row, once Settings is open */
export function revealSetting(entry: SettingEntry): void {
  pendingReveal = entry
  onReveal?.()
}

let lastSection: SectionId = 'General'

export function SettingsView({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [section, setSectionState] = useState<SectionId>(lastSection)
  const [query, setQuery] = useState('')
  const [reveal, setReveal] = useState<SettingEntry | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const mainRef = useRef<HTMLDivElement>(null)
  const panels = usePanels('settings')
  const needle = query.trim()
  const setSection = (next: SectionId): void => {
    lastSection = next
    setSectionState(next)
    setQuery('')
  }
  const sectionIndex = SECTIONS.findIndex(([id]) => id === section)
  const rows = (): HTMLElement[] => [...(mainRef.current?.querySelectorAll<HTMLElement>('[data-setting]') ?? [])]
  const focusRow = (row: HTMLElement | undefined): void => {
    row?.focus({ preventScroll: true })
    row?.scrollIntoView({ block: 'nearest' })
  }

  const { rowProps } = useListNav({
    count: SECTIONS.length,
    index: needle ? -1 : sectionIndex,
    onSelect: (index) => setSection(SECTIONS[index][0]),
    onOpen: (index) => {
      setSection(SECTIONS[index][0])
      requestAnimationFrame(() => focusRow(rows()[0]))
    }
  })

  useEffect(() => {
    const take = (): void => {
      if (!pendingReveal) return
      setSection(pendingReveal.section)
      setReveal(pendingReveal)
      pendingReveal = null
    }
    onReveal = take
    if (pendingReveal) take()
    else focusZone('list')
    return () => {
      onReveal = null
    }
  }, [])

  useEffect(() => {
    if (!reveal) return
    requestAnimationFrame(() => {
      const main = mainRef.current
      const label = CSS.escape(reveal.label)
      const row = main?.querySelector<HTMLElement>(`[data-setting="${label}"]`) ?? main?.querySelector<HTMLElement>(`[data-card="${label}"] [data-setting]`) ?? undefined
      row?.focus({ preventScroll: true })
      row?.scrollIntoView({ block: 'center' })
    })
  }, [reveal])

  const latest = useRef({ onClose, list: panels.list })
  latest.current = { onClose, list: panels.list }
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const { zone, leader } = getShell()
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || leader || isTyping(event) || (zone !== 'list' && zone !== 'main')) return
      // Keys from a drawer, dialog or menu over the page are theirs
      const origin = event.target instanceof Element && event.target !== document.body ? event.target : null
      if (origin && ![searchRef.current, mainRef.current].some((element) => element?.closest('[data-zone]')?.contains(origin))) return
      // Esc in main goes back to the list through the shell; from the list, or main without one, it leaves Settings
      if (event.key === 'Escape') {
        if (zone === 'list' || !latest.current.list) latest.current.onClose()
        return
      }
      if (event.key === '/') {
        event.preventDefault()
        return searchRef.current?.focus()
      }
      const target = event.target instanceof HTMLElement ? event.target : null
      const mainZone = mainRef.current?.closest('[data-zone]')
      if (zone !== 'main' || !mainZone || (target && target !== document.body && !mainZone.contains(target))) return
      const all = rows()
      const row = target?.closest<HTMLElement>('[data-setting]') ?? undefined
      const index = row ? all.indexOf(row) : -1
      const step = event.key === 'j' || event.key === 'ArrowDown' ? 1 : event.key === 'k' || event.key === 'ArrowUp' ? -1 : 0
      const next = step ? Math.min(all.length - 1, Math.max(0, index + step)) : event.key === 'Home' ? 0 : event.key === 'End' || event.key === 'G' ? all.length - 1 : null
      if (next !== null) {
        event.preventDefault()
        return focusRow(all[next])
      }
      if (!row) return
      const shift = event.key === 'l' || event.key === 'ArrowRight' ? 1 : event.key === 'h' || event.key === 'ArrowLeft' ? -1 : 0
      if (shift && stepSegmented(row, shift, false)) return event.preventDefault()
      // A focused control inside the row handles ⏎ and space itself
      if ((event.key === 'Enter' || event.key === ' ') && target === row) {
        event.preventDefault()
        activate(row)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <PageLayout
      id="settings"
      listLabel="Settings"
      listWidth={220}
      hints={{ list: [['/', 'search']], main: [['j k', 'move'], ['⏎', 'toggle'], ['← →', 'change']] }}
      list={
        <>
          <div className="flex h-9 shrink-0 items-center border-b border-border px-3 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Settings</div>
          <div className="shrink-0 border-b border-border p-2">
            <label className="flex h-7 items-center gap-2 rounded-md bg-muted px-2 text-xs ring-1 ring-border">
              <Icon name="search" className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                ref={searchRef}
                value={query}
                placeholder="Search settings"
                spellCheck={false}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  // First Esc clears the search, the next ones step back through the zones and leave
                  if (event.key === 'Escape' && query) {
                    event.stopPropagation()
                    setQuery('')
                  }
                  if ((event.key === 'Enter' || event.key === 'ArrowDown') && rows()[0]) {
                    event.preventDefault()
                    focusRow(rows()[0])
                  }
                }}
                className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
              />
              {!query && <kbd data-key-hint="" className="kbd">/</kbd>}
            </label>
          </div>
          <nav className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {SECTIONS.map(([id, icon], index) => (
              <button
                key={id}
                {...rowProps(index)}
                tabIndex={-1}
                onClick={() => setSection(id)}
                className={`flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-accent ${needle ? 'text-muted-foreground' : ''}`}
              >
                <Icon name={icon} className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate">{id}</span>
              </button>
            ))}
          </nav>
        </>
      }
      main={
        <>
          <header className="flex h-9 shrink-0 items-center gap-3 border-b border-border px-3">
            <ListToggle page="settings" />
            <span className="min-w-0 truncate text-xs font-medium">{needle ? `Results for “${needle}”` : section}</span>
          </header>
          <div
            ref={mainRef}
            onKeyDown={(event) => {
              // Esc in a field returns to its row, so j k carry on from there
              const row = event.target instanceof HTMLInputElement ? event.target.closest<HTMLElement>('[data-setting]') : null
              if (event.key !== 'Escape' || !row) return
              event.preventDefault()
              event.stopPropagation()
              row.focus()
            }}
            className="min-h-0 flex-1 overflow-y-auto"
          >
            <div className="mx-auto max-w-3xl px-6 py-5">
              <div className={`peer ${needle ? HIDE_WHEN_EMPTY : ''}`}>
                <SettingsSearch value={needle}>
                  {needle ? (
                    SECTIONS.map(([id]) => (
                      <SearchGroup key={id} title={id}>
                        <h2 className="mb-3 text-[13px] font-medium">{id}</h2>
                        <Section id={id} />
                      </SearchGroup>
                    ))
                  ) : (
                    <Section id={section} />
                  )}
                </SettingsSearch>
              </div>
              <p className={`hidden py-12 text-center text-[13px] break-words text-muted-foreground ${needle ? 'peer-[:not(:has([data-setting]))]:block' : ''}`}>No settings match “{needle}”</p>
            </div>
          </div>
        </>
      }
    />
  )
}

/** Picks the next or previous option of the row's segmented control; false when the row has none */
function stepSegmented(row: HTMLElement, direction: 1 | -1, wrap: boolean): boolean {
  const options = [...(row.querySelector('[data-segmented]')?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
  if (options.length === 0) return false
  const current = options.findIndex((option) => option.getAttribute('aria-pressed') === 'true')
  const next = wrap ? (current + direction + options.length) % options.length : Math.min(options.length - 1, Math.max(0, current + direction))
  options[next]?.click()
  return true
}

/** ⏎ or space on a row: flips its switch, steps its options, focuses its field or presses its button */
function activate(row: HTMLElement): void {
  if (row instanceof HTMLButtonElement) return row.click()
  const toggleControl = row.querySelector<HTMLElement>('[role="switch"]')
  if (toggleControl) return toggleControl.click()
  if (stepSegmented(row, 1, true)) return
  const control = row.querySelector<HTMLElement>('input, button:not(:disabled)')
  if (control instanceof HTMLInputElement) control.focus()
  else control?.click()
}
