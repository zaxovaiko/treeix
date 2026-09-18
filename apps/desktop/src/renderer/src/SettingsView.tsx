import { useEffect, useState } from 'react'
import type { ToolStatus } from '../../shared/types'
import { Icon } from './Icon'
import { isModifierCode, type Shortcut, shortcutLabel } from '../../shared/shortcut'
import { NAVIGATION_ACTIONS } from './codeNavigation'
import { BORDER_STRENGTHS, clampOpacity, DIGIT_MODIFIERS, type DigitModifier, type DigitTarget, FONT_SIZE_RANGE, fontStack, getSettings, MIN_OPACITY, SYSTEM_FONTS, updateSettings, useSettings } from './settings'
import { type Theme, THEMES, type ThemeId } from './themes'
import { EmptyState } from './ui'
import { Card, HIDE_WHEN_EMPTY, Row, SearchGroup, Segmented, settingMatches, SettingsSearch, Switch, useSettingMatch, useSettingsQuery } from './settingsUi'
import { isPluginEnabled, PLUGINS, setPluginEnabled, usePlugins, useService } from './plugins'
import { copyText } from './contextMenu'

const SHORTCUTS: { group: string; items: [keys: string, action: string][] }[] = [
  {
    group: 'General',
    items: [
      ['⌘K  ·  ⌘⇧P', 'Command palette'],
      ['⌘,', 'Settings'],
      ['⌃-  ·  ⌃⇧-', 'Go back or forward to the tab, worktree, file and line you were on'],
      ['⌥⌘=  ·  ⌥⌘-  ·  ⌥⌘0', 'Bigger, smaller or default font in the focused terminal, else the editor (⌘= / ⌘- zoom the window)'],
      ['Modifier + 1-9', 'Terminal panes, title bar tabs and workspaces; modifiers set in Number shortcuts'],
      ['Recorded in Hotkey window', 'Show or hide the hotkey window from any app'],
      ['Esc', 'Close dialog or cancel comment']
    ]
  },
  {
    group: 'Worktrees',
    items: [
      ['⌘B', 'Toggle sidebar'],
      ['⌘E', 'Toggle changed files'],
      ['⌘P', 'Toggle file explorer (files in the Terminal tab)'],
      ['⌘I', 'Toggle comments'],
      ['⌘J', 'Toggle terminal panel'],
      ['⌘⇧J', 'Find and switch sessions'],
      ['⌘T', 'Open the Terminal tab'],
      ['⌘N  ·  ⇧⌘T', 'New shell or Claude session in the selected worktree (⌥⌘T also starts a shell)'],
      ['⌘D  ·  ⇧⌘D', 'Split the active terminal right or down with a new shell'],
      ['⌘W', 'Close the focused terminal (agents are hidden, not ended)'],
      ['⌥⌘ arrows', 'Move focus between terminals'],
      ['⇧⌘↵', 'Maximize or restore the focused terminal'],
      ['J  ·  K', 'Next or previous changed file'],
      ['R', 'Rescan worktrees'],
      ['⇧⌘F', 'Search across projects in scope']
    ]
  },
  {
    group: 'Code navigation',
    items: [
      ['⌘ click', 'Go to definition, or references when on the definition'],
      ['Recorded in Code navigation', 'Definition, type definition, implementations, references (F12 keys by default)'],
      ['Hover', 'Type and docs; dotted underline marks a navigable symbol'],
      ['Right click', 'All navigation actions for the symbol']
    ]
  },
  {
    group: 'Comments',
    items: [
      ['Drag lines', 'Comment on a range'],
      ['⌘↵', 'Save comment'],
      ['⌘V', 'Paste an image or file as an attachment']
    ]
  }
]

const DIGIT_TARGETS: { target: DigitTarget; label: string; description: string }[] = [
  { target: 'panes', label: 'Terminal panes', description: 'Focus the nth terminal on screen, opening the Terminal tab if none is shown.' },
  { target: 'tabs', label: 'Tabs', description: 'Worktrees, Terminal, Pull requests, then open PR and plan tabs; 9 is the last tab.' },
  { target: 'workspaces', label: 'Workspaces', description: 'Workspaces in rail order. ⌃ digits also switch macOS desktops.' }
]

/** Click, then press the combination; Esc cancels. Bare keys like § or F12 are allowed. */
function ShortcutRecorder({ value, onChange }: { value: Shortcut | null; onChange: (shortcut: Shortcut | null) => void }): React.JSX.Element {
  const [recording, setRecording] = useState(false)

  useEffect(() => {
    if (!recording) return
    // The current global hotkey would fire instead of being recorded
    window.api.configureHotkey({ shortcut: null, hideOnBlur: false, only: getSettings().hotkeyOnly })
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
          recording ? 'animate-pulse text-primary ring-primary' : value ? 'text-foreground ring-border hover:bg-accent' : 'text-muted-foreground ring-border hover:bg-accent'
        }`}
      >
        {recording ? 'Press shortcut…' : value ? shortcutLabel(value) : 'Record shortcut'}
      </button>
      {value && !recording && (
        <button title="Turn off" onClick={() => onChange(null)} className="grid size-8 place-items-center rounded-lg text-muted-foreground ring-1 ring-border hover:text-foreground">
          <Icon name="close" className="size-3.5" />
        </button>
      )}
    </div>
  )
}

function HotkeyWindow(): React.JSX.Element {
  const { hotkey, hotkeyHideOnBlur, hotkeyOnly } = useSettings()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.api.configureHotkey({ shortcut: hotkey, hideOnBlur: hotkeyHideOnBlur, only: hotkeyOnly && hotkey !== null }).then(setError)
  }, [hotkey, hotkeyHideOnBlur, hotkeyOnly])

  return (
    <Card title="Hotkey window">
      <Row
        label="Global shortcut"
        description="Drops Treeix over everything, full screen below the menu bar, from any app. Press again to hide. Any key works, including § on ISO keyboards; while it is set, that key opens Treeix instead of typing."
      >
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <ShortcutRecorder value={hotkey} onChange={(next) => updateSettings({ hotkey: next })} />
          {error && <span className="max-w-72 text-right text-[11px] text-amber-400">{error}</span>}
        </div>
      </Row>
      <Row label="Hide when focus is lost" description="Clicking another app puts the hotkey window away, like iTerm2.">
        <Switch checked={hotkeyHideOnBlur} label="Hide when focus is lost" onChange={() => updateSettings({ hotkeyHideOnBlur: !hotkeyHideOnBlur })} />
      </Row>
      <Row
        label="Hotkey window only"
        description="No normal window: Treeix always stays the drop-down and only shows or hides, so nothing resizes or re-renders when it appears. Needs a global shortcut."
      >
        <Switch checked={hotkeyOnly} label="Hotkey window only" onChange={() => updateSettings({ hotkeyOnly: !hotkeyOnly })} />
      </Row>
    </Card>
  )
}

function General(): React.JSX.Element {
  const settings = useSettings()
  return (
    <>
      <Plugins />
      <Card title="Layout">
        <Row label="Diff view" description="How diffs render in worktrees and pull requests. Also switchable from the diff header.">
          <Segmented
            value={settings.diffStyle}
            options={[
              ['split', 'Split'],
              ['unified', 'Unified']
            ]}
            onChange={(diffStyle) => updateSettings({ diffStyle })}
          />
        </Row>
        <Row
          label="Sections"
          description="Whether folder groups start expanded or hidden. Panels start open and remember when you close them."
        >
          <Segmented
            value={settings.sections}
            options={[
              ['hidden', 'Hidden'],
              ['expanded', 'Expanded']
            ]}
            onChange={(sections) => updateSettings({ sections })}
          />
        </Row>
        <Row label="Bottom panel" description="Whether a panel docked at the bottom, like the terminal, sits beside the sidebar or spans the full width under it. Applies to every tab.">
          <Segmented
            value={settings.bottomPanel}
            options={[
              ['content', 'Beside sidebar'],
              ['full', 'Full width']
            ]}
            onChange={(bottomPanel) => updateSettings({ bottomPanel })}
          />
        </Row>
        <Row label="Branches in sidebar" description="List branches that have no worktree under each project in the Worktrees sidebar.">
          <Switch checked={settings.sidebarBranches} label="Branches in sidebar" onChange={() => updateSettings({ sidebarBranches: !settings.sidebarBranches })} />
        </Row>
      </Card>
      <HotkeyWindow />
      <Card title="Number shortcuts">
        {DIGIT_TARGETS.map(({ target, label, description }) => {
          const modifier = settings.digitShortcuts[target]
          const clash = modifier !== 'off' && DIGIT_TARGETS.some((other) => other.target !== target && settings.digitShortcuts[other.target] === modifier)
          return (
            <Row key={target} label={label} description={clash ? `${description} Same modifier as another row, so only one of them works.` : description}>
              <Segmented
                value={modifier}
                options={Object.entries(DIGIT_MODIFIERS).map(([id, name]) => [id as DigitModifier, name])}
                onChange={(next) => updateSettings({ digitShortcuts: { ...settings.digitShortcuts, [target]: next } })}
              />
            </Row>
          )
        })}
      </Card>
      <Card title="Code navigation">
        {NAVIGATION_ACTIONS.map(({ kind, label, description }) => (
          <Row key={kind} label={label} description={description}>
            <ShortcutRecorder
              value={settings.navigationKeys[kind]}
              onChange={(next) => updateSettings({ navigationKeys: { ...getSettings().navigationKeys, [kind]: next } })}
            />
          </Row>
        ))}
      </Card>
      <Card title="Performance">
        <Row
          label="Highlighting workers"
          description="More workers highlight large diffs faster but each keeps its own grammars in memory. Applies after restart."
        >
          <div className="flex shrink-0 gap-0.5 rounded-lg bg-muted p-1 ring-1 ring-border">
            {[1, 2, 3, 4].map((count) => (
              <button
                key={count}
                onClick={() => updateSettings({ highlightWorkers: count })}
                className={`h-6 w-7 rounded-md text-xs ${
                  settings.highlightWorkers === count ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {count}
              </button>
            ))}
          </div>
        </Row>
      </Card>
    </>
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

/** Free-text family name with installed fonts suggested, each previewed in itself */
function FontPicker({ value, monospace, onChange }: { value: string; monospace: boolean; onChange: (family: string) => void }): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  const [fonts, setFonts] = useState<FontFamily[]>([])
  const [open, setOpen] = useState(false)
  useEffect(() => setDraft(value), [value])
  const needle = draft.trim().toLowerCase()
  const exact = fonts.some((font) => font.name.toLowerCase() === needle)
  const system = SYSTEM_FONTS.filter((font) => font.monospace === monospace).map(({ value, label }) => ({ name: value, label, monospace }))
  const suggestions = [...system, ...fonts]
    .filter((font) => (!monospace || font.monospace) && (exact || !needle || `${font.name} ${font.label ?? ''}`.toLowerCase().includes(needle)))
    .slice(0, MAX_FONT_SUGGESTIONS)
  const commit = (family: string): void => {
    setDraft(family)
    setOpen(false)
    if (family.trim() !== value) onChange(family.trim())
  }
  return (
    <div className="relative w-56 shrink-0">
      <input
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
        }}
        onBlur={() => commit(draft)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') {
            event.stopPropagation()
            setDraft(value)
            setOpen(false)
          }
        }}
        style={{ fontFamily: draft.trim() ? fontStack(draft, 'sans-serif') : undefined }}
        className="h-8 w-full rounded-md border border-input bg-muted px-2.5 pr-7 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary/60"
      />
      {value && (
        <button onMouseDown={(event) => event.preventDefault()} onClick={() => commit('')} title="Use default" className="absolute top-2 right-2 text-muted-foreground hover:text-foreground">
          <Icon name="close" className="size-3.5" />
        </button>
      )}
      {open && suggestions.length > 0 && (
        <div className="absolute inset-x-0 top-9 z-20 max-h-64 overflow-y-auto rounded-lg border border-input bg-popover p-1">
          {suggestions.map((font) => (
            <button
              key={font.name}
              // mousedown keeps focus in the input, so blur doesn't commit the typed text first
              onMouseDown={(event) => {
                event.preventDefault()
                commit(font.name)
              }}
              className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-foreground/85 hover:bg-accent"
            >
              {/* Names in the UI font stay readable for symbol fonts; the sample shows the face itself */}
              <span className="min-w-0 flex-1 truncate">{font.label ?? font.name}</span>
              <span style={{ fontFamily: fontStack(font.name, 'sans-serif') }} className="shrink-0 text-muted-foreground">
                Aa 0O
              </span>
              {font.name === value && <Icon name="check" className="size-3 shrink-0 text-primary" />}
            </button>
          ))}
        </div>
      )}
    </div>
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
    <button data-setting onClick={onSelect} className={`overflow-hidden rounded-lg text-left ring-1 ${selected ? 'ring-2 ring-primary' : 'ring-border hover:ring-input'}`}>
      {children}
      <div className="flex items-center gap-2 bg-card px-2.5 py-2 text-xs">
        {label}
        {selected && <Icon name="check" className="ml-auto size-3 text-primary" />}
      </div>
    </button>
  )
}

function Appearance(): React.JSX.Element {
  const { theme: current, opacity, borderStrength, editorFontSize, terminalFontSize, uiFont, editorFont, terminalFont } = useSettings()
  return (
    <>
    <Card title="Window">
      <Row label="Transparency" description="Lets the blurred desktop show through backgrounds while text stays solid. Applies instantly.">
        <div className="flex w-56 shrink-0 items-center gap-3">
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
      </Row>
      <Row label="Borders" description="How visible dividers and field outlines are, from none to the theme's full strength.">
        <Segmented
          value={`${borderStrength}`}
          options={BORDER_STRENGTHS.map((strength): [string, string] => [`${strength}`, `${strength}%`])}
          onChange={(value) => updateSettings({ borderStrength: BORDER_STRENGTHS.find((strength) => `${strength}` === value) ?? 100 })}
        />
      </Row>
    </Card>
    <Card title="Fonts">
      <Row label="Interface" description="Menus, lists, markdown and everything that isn't code.">
        <FontPicker value={uiFont} monospace={false} onChange={(family) => updateSettings({ uiFont: family })} />
      </Row>
      <Row label="Editor" description="Code in the editor, diffs and pull requests. Size is independent of window zoom (⌘+ / ⌘-).">
        <div className="flex shrink-0 items-center gap-2">
          <FontPicker value={editorFont} monospace onChange={(family) => updateSettings({ editorFont: family })} />
          <FontSize label="editor font" value={editorFontSize} fallback={13} onChange={(size) => updateSettings({ editorFontSize: size })} />
        </div>
      </Row>
      <Row label="Terminal" description="Terminal and agent sessions. Open terminals resize to fit.">
        <div className="flex shrink-0 items-center gap-2">
          <FontPicker value={terminalFont} monospace onChange={(family) => updateSettings({ terminalFont: family })} />
          <FontSize label="terminal font" value={terminalFontSize} fallback={12} onChange={(size) => updateSettings({ terminalFontSize: size })} />
        </div>
      </Row>
    </Card>
    <Card title="Theme">
      <div className="grid grid-cols-2 gap-3 p-4 lg:grid-cols-3">
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
    </>
  )
}

function ShortcutRow({ keys, action }: { keys: string; action: string }): React.JSX.Element | null {
  if (!useSettingMatch(action, keys, 'shortcut')) return null
  return (
    <div data-setting className="flex items-center border-b border-border px-4 py-2.5 text-[13px] last:border-b-0">
      <span className="flex-1">{action}</span>
      <kbd className="rounded-md bg-muted px-2 py-0.5 font-sans text-xs whitespace-pre text-muted-foreground ring-1 ring-border">{keys}</kbd>
    </div>
  )
}

function Shortcuts(): React.JSX.Element {
  return (
    <>
      {SHORTCUTS.map(({ group, items }) => (
        <Card key={group} title={`${group} shortcuts`}>
          {items.map(([keys, action]) => (
            <ShortcutRow key={action} keys={keys} action={action} />
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
              <div className="ml-4 border-l border-border [&>div]:border-b-0">
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
        className="h-6 rounded-md px-2 text-[11px] text-muted-foreground ring-1 ring-border hover:text-foreground"
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
      className="flex h-6 items-center gap-1.5 rounded-md bg-primary/15 px-2 text-[11px] font-medium text-primary ring-1 ring-primary/40 hover:bg-primary/25 disabled:opacity-70"
    >
      {running && <Icon name="refresh" className="size-3 animate-spin" />}
      {running ? 'Updating…' : 'Update'}
    </button>
  )
}

function Integrations(): React.JSX.Element {
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
    <SearchGroup title="Command line tools integrations" className="mb-8">
      <div className="mb-2 flex items-center">
        <h2 className="text-[13px] font-medium">Command line tools</h2>
        <button
          onClick={() => void check()}
          className="ml-auto flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs text-muted-foreground ring-1 ring-border hover:text-foreground"
        >
          <Icon name="refresh" className={`size-3 ${checking ? 'animate-spin' : ''}`} />
          Check again
        </button>
      </div>
      <div className="rounded-xl border border-border bg-card">
        {!tools && <EmptyState title="Checking your login shell..." />}
        {tools?.map((tool) => (
          <ToolRow key={tool.name} tool={tool} check={check} />
        ))}
      </div>
    </SearchGroup>
  )
}

function ToolRow({ tool, check }: { tool: ToolStatus; check: () => Promise<void> }): React.JSX.Element | null {
  if (!useSettingMatch(tool.name, tool.purpose)) return null
  return (
    <div data-setting className="flex items-start gap-3 border-b border-border px-4 py-3.5 last:border-b-0">
      <span className={`mt-1.5 size-2 shrink-0 rounded-full ${tool.error ? (tool.version ? 'bg-amber-400' : 'bg-red-400') : 'bg-emerald-400'}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[13px]">
          <ToolMark name={tool.name} />
          <span className="font-mono">{tool.name}</span>
          <span className="text-xs text-muted-foreground">{tool.purpose}</span>
        </div>
        {tool.version && <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{tool.version}</div>}
        {tool.update && (
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-sky-400">
            <span className="select-text">Update available: {tool.update}</span>
            {tool.updateCommand && <UpdateButton command={tool.updateCommand} onDone={check} />}
          </div>
        )}
        {tool.accounts?.map((account) => (
          <div key={account} className="mt-0.5 text-xs text-emerald-400">
            Signed in as {account}
          </div>
        ))}
        {tool.error && <div className="mt-0.5 text-xs text-amber-400 select-text">{tool.error}</div>}
      </div>
    </div>
  )
}

export function SettingsView({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [query, setQuery] = useState('')

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-8 py-8">
        <div className="mb-6 flex items-center">
          <h1 className="text-lg font-semibold">Settings</h1>
          <label className="mr-3 ml-auto flex h-7 w-64 items-center gap-2 rounded-md px-2.5 text-xs ring-1 ring-border focus-within:ring-primary">
            <Icon name="search" className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              placeholder="Search settings"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                // First Esc clears the search, the next one closes settings
                if (event.key === 'Escape' && query) {
                  event.stopPropagation()
                  setQuery('')
                }
              }}
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
            />
          </label>
          <button onClick={onClose} className="h-7 rounded-md px-2.5 text-xs text-muted-foreground ring-1 ring-border hover:text-foreground">
            Done (Esc)
          </button>
        </div>
        <div className={`peer ${query.trim() ? HIDE_WHEN_EMPTY : ''}`}>
          <SettingsSearch value={query.trim()}>
            <General />
            <Appearance />
            <Integrations />
            <Shortcuts />
          </SettingsSearch>
        </div>
        <p className={`hidden py-12 text-center text-[13px] text-muted-foreground ${query.trim() ? 'peer-[:not(:has([data-setting]))]:block' : ''}`}>
          No settings match “{query.trim()}”
        </p>
      </div>
    </div>
  )
}
