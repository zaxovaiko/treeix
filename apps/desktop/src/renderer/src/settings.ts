import { useSyncExternalStore } from 'react'
import { setKeymapOverrides } from '../../shared/keymap'
import { isShortcut, type Shortcut } from '../../shared/shortcut'
import type { NavigationKind } from '../../shared/types'
import type { Agent } from './agents'
import { codeTheme, DEFAULT_THEME, resolveTheme, subscribeThemes, type Theme } from './themes'

export type Settings = {
  /** Plugins switched on or off in Settings, by id; absent ones follow their manifest's default */
  plugins: Record<string, boolean>
  /** Agents the user added or redefined, merged over the built-in table by id */
  customAgents: Agent[]
  /** Default view per agent id; absent means terminal */
  agentViews: Record<string, 'chat' | 'terminal'>
  /** How a chat session shows an agent's thinking blocks */
  chatThinking: 'collapsed' | 'expanded' | 'hidden'
  /** Background syntax highlighting workers; applied on next launch */
  highlightWorkers: number
  /** 'system' follows the macOS appearance: Neutral when dark, Light when light */
  /** 'system' follows the macOS appearance between the light and the dark theme */
  themeMode: ThemeMode
  lightTheme: string
  darkTheme: string
  diffStyle: 'split' | 'unified'
  /** Whether panels start open and folder groups start expanded */
  sections: 'expanded' | 'hidden'
  /** A bottom panel sits under the content beside the sidebar, or spans the full width under it */
  bottomPanel: 'content' | 'full'
  editorMinimap: boolean
  editorLineNumbers: 'on' | 'relative' | 'off'
  editorWordWrap: boolean
  /** Starts Claude sessions with --dangerously-skip-permissions */
  claudeSkipPermissions: boolean
  /** A macOS notification when an agent finishes or needs an answer while the window is in the background */
  agentNotifications: boolean
  /** Local and remote branches without a worktree, listed under each project in the sidebar */
  sidebarBranches: boolean
  /** Window opacity in percent */
  opacity: number
  /** Strength of hairline borders and input outlines, in percent of the theme's own */
  borderStrength: BorderStrength
  /** Recorded global shortcut for the drop-down hotkey window, null turns it off */
  hotkey: Shortcut | null
  hotkeyHideOnBlur: boolean
  hotkeyOnly: boolean
  /** In-app code navigation keys; macOS sends F-keys only with fn unless standard function keys are on, so they can be re-recorded */
  navigationKeys: Record<NavigationKind, Shortcut | null>
  /** Modifier held with 1-9 to jump to a terminal pane, a title bar tab or a workspace; tabs are off by default since the G leader goes to pages */
  digitShortcuts: Record<DigitTarget, DigitModifier>
  /** Rebound action keys by action id; an id absent here keeps the key it ships with, one set to null is unbound */
  keymap: Record<string, Shortcut | null>
  /** Code font size in px for editors, diffs and previews, independent of window zoom */
  editorFontSize: number
  terminalFontSize: number
  /** 'auto' draws a step heavier on light themes, where GPU-drawn text misses macOS font smoothing */
  terminalFontWeight: TerminalFontWeight
  /** xterm's minimumContrastRatio: text colors are pushed until they reach it against the background; 1 is off */
  terminalContrast: TerminalContrast
  /** Lines each terminal keeps above its screen */
  terminalScrollback: number
  /** Font family names; empty keeps the built-in stack */
  uiFont: string
  editorFont: string
  terminalFont: string
}

export const THEME_MODES = ['system', 'light', 'dark'] as const
export type ThemeMode = (typeof THEME_MODES)[number]

const nonEmpty = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)

/** Earlier versions stored one `theme`: 'system', 'light', or one of the dark themes */
export function parseAppearance(stored: Record<string, unknown>): Pick<Settings, 'themeMode' | 'lightTheme' | 'darkTheme'> {
  const legacy = nonEmpty(stored.theme)
  const legacyMode: ThemeMode | null = legacy === 'system' || legacy === 'light' ? legacy : legacy ? 'dark' : null
  return {
    themeMode: THEME_MODES.find((mode) => mode === stored.themeMode) ?? legacyMode ?? 'dark',
    lightTheme: nonEmpty(stored.lightTheme) ?? DEFAULT_THEME.light,
    darkTheme: nonEmpty(stored.darkTheme) ?? (legacyMode === 'dark' && legacy ? legacy : DEFAULT_THEME.dark)
  }
}

export const TERMINAL_FONT_WEIGHTS = ['auto', '300', '400', '500', '600'] as const
export type TerminalFontWeight = (typeof TERMINAL_FONT_WEIGHTS)[number]
export const TERMINAL_CONTRASTS = [1, 3, 4.5, 7] as const
export type TerminalContrast = (typeof TERMINAL_CONTRASTS)[number]

const KEY = 'settings'
export const MIN_OPACITY = 40
export const BORDER_STRENGTHS = [0, 25, 50, 75, 100] as const
export type BorderStrength = (typeof BORDER_STRENGTHS)[number]
const key = (code: string, modifiers: Partial<Shortcut> = {}): Shortcut => ({ code, meta: false, alt: false, ctrl: false, shift: false, ...modifiers })

/** Earlier versions stored one of a few preset accelerators */
const PRESET_HOTKEYS: Record<string, Shortcut | null> = {
  'Alt+`': key('Backquote', { alt: true }),
  'Control+`': key('Backquote', { ctrl: true }),
  'Alt+Space': key('Space', { alt: true }),
  'Command+Escape': key('Escape', { meta: true }),
  F12: key('F12'),
  off: null
}

function parseHotkey(value: unknown): Shortcut | null {
  if (value === null || isShortcut(value)) return value
  return typeof value === 'string' && value in PRESET_HOTKEYS ? PRESET_HOTKEYS[value] : DEFAULTS.hotkey
}
function parseNavigationKeys(value: unknown): Settings['navigationKeys'] {
  const stored = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const pick = (kind: NavigationKind): Shortcut | null => {
    const candidate = stored[kind]
    return candidate === null || isShortcut(candidate) ? candidate : DEFAULTS.navigationKeys[kind]
  }
  return { definition: pick('definition'), typeDefinition: pick('typeDefinition'), implementation: pick('implementation'), references: pick('references') }
}
export const DIGIT_MODIFIERS = { meta: '⌘', alt: '⌥', ctrl: '⌃', altMeta: '⌥⌘', ctrlMeta: '⌃⌘', off: 'Off' } as const
export type DigitModifier = keyof typeof DIGIT_MODIFIERS
export type DigitTarget = 'tabs' | 'workspaces'
const isDigitModifier = (value: unknown): value is DigitModifier => typeof value === 'string' && value in DIGIT_MODIFIERS

function parseKeymap(value: unknown): Settings['keymap'] {
  const stored = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, Shortcut | null] => entry[1] === null || isShortcut(entry[1])))
}

export function parseAgentViews(value: unknown): Settings['agentViews'] {
  const stored = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, 'chat' | 'terminal'] => entry[1] === 'chat' || entry[1] === 'terminal'))
}

export const parseChatThinking = (value: unknown): Settings['chatThinking'] => (value === 'expanded' || value === 'hidden' ? value : 'collapsed')

function parseDigitShortcuts(value: unknown): Settings['digitShortcuts'] {
  const stored = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const pick = (target: DigitTarget): DigitModifier => {
    const candidate = stored[target]
    return isDigitModifier(candidate) ? candidate : DEFAULTS.digitShortcuts[target]
  }
  return { tabs: pick('tabs'), workspaces: pick('workspaces') }
}

/** The 0-9 digit when the physical digit key is pressed with exactly this modifier */
export function digitPressed(event: KeyboardEvent, modifier: DigitModifier): number | null {
  const digit = event.code.match(/^Digit([0-9])$/)?.[1]
  if (!digit || modifier === 'off') return null
  const meta = modifier === 'meta' || modifier === 'altMeta' || modifier === 'ctrlMeta'
  const alt = modifier === 'alt' || modifier === 'altMeta'
  const ctrl = modifier === 'ctrl' || modifier === 'ctrlMeta'
  const matches = event.metaKey === meta && event.altKey === alt && event.ctrlKey === ctrl && !event.shiftKey
  return matches ? Number(digit) : null
}

export const digitLabel = (target: DigitTarget, digit: number | string): string => {
  const modifier = getSettings().digitShortcuts[target]
  return modifier === 'off' ? '' : `${DIGIT_MODIFIERS[modifier]}${digit}`
}

export const FONT_SIZE_RANGE = { min: 9, max: 24 } as const
const clampFontSize = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.min(FONT_SIZE_RANGE.max, Math.max(FONT_SIZE_RANGE.min, value))) : fallback

export const SANS_STACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
export const MONO_STACK = "ui-monospace, 'SF Mono', Menlo, monospace"
/** A chosen family in front of the default stack, so a missing font still falls back */
export function fontStack(family: string, fallback: string): string {
  const name = family.trim().replace(/["\\]/g, '')
  if (!name) return fallback
  return `${SYSTEM_FONTS.some((font) => font.value === name) ? name : `"${name}"`}, ${fallback}`
}

/** macOS system faces aren't in the installed font list; CSS reaches them only through these keywords */
export const SYSTEM_FONTS: { value: string; label: string; monospace: boolean }[] = [
  { value: 'system-ui', label: 'System (SF Pro)', monospace: false },
  { value: 'ui-rounded', label: 'SF Pro Rounded', monospace: false },
  { value: 'ui-serif', label: 'New York', monospace: false },
  { value: 'ui-monospace', label: 'System mono (SF Mono)', monospace: true }
]

/** Grows or shrinks a font size by one pixel within range; 0 restores the default */
export function stepFontSize(key: 'editorFontSize' | 'terminalFontSize', step: -1 | 0 | 1): void {
  const size = step === 0 ? DEFAULTS[key] : clampFontSize(settings[key] + step, DEFAULTS[key])
  if (size !== settings[key]) updateSettings({ [key]: size })
}

const SCROLLBACK_RANGE = { min: 500, max: 50_000 } as const
const clampScrollback = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.min(SCROLLBACK_RANGE.max, Math.max(SCROLLBACK_RANGE.min, value))) : DEFAULTS.terminalScrollback

/** Below the minimum the window becomes hard to find, so values are clamped */
export const clampOpacity = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.min(100, Math.max(MIN_OPACITY, value))) : 100
const DEFAULTS: Settings = { plugins: {}, customAgents: [], agentViews: {}, chatThinking: 'collapsed', highlightWorkers: 2, themeMode: 'dark', lightTheme: DEFAULT_THEME.light, darkTheme: DEFAULT_THEME.dark, diffStyle: 'split', sections: 'hidden', bottomPanel: 'content', editorMinimap: true, editorLineNumbers: 'on', editorWordWrap: false, claudeSkipPermissions: false, agentNotifications: true, sidebarBranches: false, opacity: 100, borderStrength: 100, hotkey: { code: 'Backquote', meta: false, alt: true, ctrl: false, shift: false }, hotkeyHideOnBlur: true, hotkeyOnly: false, editorFontSize: 13, terminalFontSize: 12, terminalFontWeight: 'auto', terminalContrast: 4.5, terminalScrollback: 5000, uiFont: '', editorFont: '', terminalFont: '', digitShortcuts: { tabs: 'off', workspaces: 'altMeta' }, keymap: {}, navigationKeys: { definition: key('F12'), typeDefinition: null, implementation: key('F12', { meta: true }), references: key('F12', { shift: true }) } }

/** Before plugins, four features had their own on/off switch under these keys */
const LEGACY_MODULES: Record<string, string> = { terminal: 'terminal', pullRequests: 'pull-requests', plans: 'plans', diagrams: 'diagrams' }

function parsePluginChoices(candidate: Record<string, unknown>): Record<string, boolean> {
  const legacy = Object.entries(LEGACY_MODULES).flatMap(([key, id]) => (typeof candidate[key] === 'boolean' ? [[id, candidate[key]]] : []))
  const stored = typeof candidate.plugins === 'object' && candidate.plugins !== null ? Object.entries(candidate.plugins) : []
  return Object.fromEntries([...legacy, ...stored.filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean')])
}

export function parseCustomAgents(value: unknown): Agent[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): Agent[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const candidate = entry as Record<string, unknown>
    const text = (key: string): string | undefined => (typeof candidate[key] === 'string' ? (candidate[key] as string) : undefined)
    const id = text('id')
    if (!id) return []
    const chatCandidate = typeof candidate.chat === 'object' && candidate.chat !== null ? (candidate.chat as Record<string, unknown>) : undefined
    const chat = typeof chatCandidate?.adapter === 'string' && typeof chatCandidate.command === 'string' ? { adapter: chatCandidate.adapter, command: chatCandidate.command } : undefined
    return [
      {
        id,
        label: text('label') ?? id,
        mark: text('mark') ?? '●',
        color: text('color') ?? 'var(--color-foreground)',
        command: text('command') ?? null,
        promptFlag: text('promptFlag'),
        sessionIdFlag: text('sessionIdFlag'),
        resumeCommand: text('resumeCommand'),
        resumeLatestCommand: text('resumeLatestCommand'),
        agent: candidate.agent !== false,
        ...(chat ? { chat } : {})
      }
    ]
  })
}

function load(): Settings {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    if (typeof stored !== 'object' || stored === null) return DEFAULTS
    const candidate = stored as Partial<Record<keyof Settings, unknown>>
    const flag = (key: 'hotkeyHideOnBlur' | 'hotkeyOnly' | 'editorMinimap' | 'editorWordWrap'): boolean => (typeof candidate[key] === 'boolean' ? candidate[key] : DEFAULTS[key])
    const workers = candidate.highlightWorkers
    return {
      plugins: parsePluginChoices(candidate),
      customAgents: parseCustomAgents(candidate.customAgents),
      agentViews: parseAgentViews(candidate.agentViews),
      chatThinking: parseChatThinking(candidate.chatThinking),
      ...parseAppearance(candidate),
      diffStyle: candidate.diffStyle === 'unified' ? 'unified' : 'split',
      sections: candidate.sections === 'expanded' ? 'expanded' : 'hidden',
      bottomPanel: candidate.bottomPanel === 'full' ? 'full' : 'content',
      editorMinimap: flag('editorMinimap'),
      editorLineNumbers: candidate.editorLineNumbers === 'relative' || candidate.editorLineNumbers === 'off' ? candidate.editorLineNumbers : 'on',
      editorWordWrap: flag('editorWordWrap'),
      claudeSkipPermissions: candidate.claudeSkipPermissions === true,
      agentNotifications: candidate.agentNotifications !== false,
      sidebarBranches: candidate.sidebarBranches === true,
      opacity: clampOpacity(candidate.opacity),
      borderStrength: BORDER_STRENGTHS.find((strength) => strength === candidate.borderStrength) ?? DEFAULTS.borderStrength,
      hotkey: 'hotkey' in candidate ? parseHotkey(candidate.hotkey) : DEFAULTS.hotkey,
      hotkeyHideOnBlur: flag('hotkeyHideOnBlur'),
      hotkeyOnly: flag('hotkeyOnly'),
      navigationKeys: parseNavigationKeys(candidate.navigationKeys),
      digitShortcuts: parseDigitShortcuts(candidate.digitShortcuts),
      keymap: parseKeymap(candidate.keymap),
      editorFontSize: clampFontSize(candidate.editorFontSize, DEFAULTS.editorFontSize),
      terminalFontSize: clampFontSize(candidate.terminalFontSize, DEFAULTS.terminalFontSize),
      terminalScrollback: clampScrollback(candidate.terminalScrollback),
      terminalFontWeight: TERMINAL_FONT_WEIGHTS.find((weight) => weight === candidate.terminalFontWeight) ?? DEFAULTS.terminalFontWeight,
      terminalContrast: TERMINAL_CONTRASTS.find((ratio) => ratio === candidate.terminalContrast) ?? DEFAULTS.terminalContrast,
      uiFont: typeof candidate.uiFont === 'string' ? candidate.uiFont : '',
      editorFont: typeof candidate.editorFont === 'string' ? candidate.editorFont : '',
      terminalFont: typeof candidate.terminalFont === 'string' ? candidate.terminalFont : '',
      highlightWorkers: typeof workers === 'number' && workers >= 1 && workers <= 4 ? workers : DEFAULTS.highlightWorkers
    }
  } catch {
    return DEFAULTS
  }
}

let settings = load()
setKeymapOverrides(settings.keymap)
const listeners = new Set<() => void>()

export const getSettings = (): Settings => settings

/** The global shortcut only summons the hotkey window while that window is switched on */
export function hotkeyOptions(): { shortcut: Shortcut | null; hideOnBlur: boolean; only: boolean } {
  const { hotkey, hotkeyHideOnBlur, hotkeyOnly } = settings
  const shortcut = hotkeyOnly ? hotkey : null
  return { shortcut, hideOnBlur: hotkeyHideOnBlur, only: shortcut !== null }
}

export function updateSettings(patch: Partial<Settings>): void {
  settings = { ...settings, ...patch }
  localStorage.setItem(KEY, JSON.stringify(settings))
  if (patch.keymap) setKeymapOverrides(settings.keymap)
  listeners.forEach((listener) => listener())
}

export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const useSettings = (): Settings => useSyncExternalStore(subscribeSettings, () => settings)

// Absent outside the renderer (bun tests), where 'system' resolves to dark
const systemDark = typeof window === 'undefined' ? null : window.matchMedia('(prefers-color-scheme: dark)')

/** The mode shown, resolving 'system' against the macOS appearance */
const activeMode = (): Theme['mode'] => (settings.themeMode !== 'system' ? settings.themeMode : (systemDark?.matches ?? true) ? 'dark' : 'light')

export const activeThemeId = (): string => (activeMode() === 'light' ? settings.lightTheme : settings.darkTheme)

/** The theme actually shown */
export const activeTheme = (): Theme => resolveTheme(activeThemeId(), activeMode())
/** Code colors for both slots, so a system appearance flip needs no re-highlight */
export const codeThemes = (): Record<Theme['mode'], string> => ({
  dark: codeTheme(resolveTheme(settings.darkTheme, 'dark')),
  light: codeTheme(resolveTheme(settings.lightTheme, 'light'))
})

// A new settings object makes useSettings consumers re-render when the appearance flips under 'system' or plugin themes change
const refresh = (): void => {
  settings = { ...settings }
  listeners.forEach((listener) => listener())
}
systemDark?.addEventListener('change', () => {
  if (settings.themeMode === 'system') refresh()
})
subscribeThemes(refresh)

/** Folder groups follow the sections setting; `toggled` holds the ones the user flipped */
export const groupOpen = (toggled: Set<string>, key: string): boolean => (getSettings().sections === 'expanded') !== toggled.has(key)

export function toggleIn(set: Set<string>, key: string): Set<string> {
  const next = new Set(set)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}
