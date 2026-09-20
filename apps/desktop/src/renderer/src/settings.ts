import { useSyncExternalStore } from 'react'
import { isShortcut, type Shortcut } from '../../shared/shortcut'
import type { NavigationKind } from '../../shared/types'
import { isThemeId, type ThemeId } from './themes'

export type Settings = {
  /** Plugins switched on or off in Settings, by id; absent ones follow their manifest's default */
  plugins: Record<string, boolean>
  /** Background syntax highlighting workers; applied on next launch */
  highlightWorkers: number
  /** 'system' follows the macOS appearance: Neutral when dark, Light when light */
  theme: ThemeId | 'system'
  diffStyle: 'split' | 'unified'
  /** Whether panels start open and folder groups start expanded */
  sections: 'expanded' | 'hidden'
  /** A bottom panel sits under the content beside the sidebar, or spans the full width under it */
  bottomPanel: 'content' | 'full'
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
  /** Code font size in px for editors, diffs and previews, independent of window zoom */
  editorFontSize: number
  terminalFontSize: number
  /** Lines each terminal keeps above its screen */
  terminalScrollback: number
  /** Font family names; empty keeps the built-in stack */
  uiFont: string
  editorFont: string
  terminalFont: string
}

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
const DEFAULTS: Settings = { plugins: {}, highlightWorkers: 2, theme: 'neutral', diffStyle: 'split', sections: 'hidden', bottomPanel: 'content', sidebarBranches: false, opacity: 100, borderStrength: 100, hotkey: { code: 'Backquote', meta: false, alt: true, ctrl: false, shift: false }, hotkeyHideOnBlur: true, hotkeyOnly: false, editorFontSize: 13, terminalFontSize: 12, terminalScrollback: 5000, uiFont: '', editorFont: '', terminalFont: '', digitShortcuts: { tabs: 'off', workspaces: 'altMeta' }, navigationKeys: { definition: key('F12'), typeDefinition: null, implementation: key('F12', { meta: true }), references: key('F12', { shift: true }) } }

/** Before plugins, four features had their own on/off switch under these keys */
const LEGACY_MODULES: Record<string, string> = { terminal: 'terminal', pullRequests: 'pull-requests', plans: 'plans', diagrams: 'diagrams' }

function parsePluginChoices(candidate: Record<string, unknown>): Record<string, boolean> {
  const legacy = Object.entries(LEGACY_MODULES).flatMap(([key, id]) => (typeof candidate[key] === 'boolean' ? [[id, candidate[key]]] : []))
  const stored = typeof candidate.plugins === 'object' && candidate.plugins !== null ? Object.entries(candidate.plugins) : []
  return Object.fromEntries([...legacy, ...stored.filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean')])
}

function load(): Settings {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    if (typeof stored !== 'object' || stored === null) return DEFAULTS
    const candidate = stored as Partial<Record<keyof Settings, unknown>>
    const flag = (key: 'hotkeyHideOnBlur' | 'hotkeyOnly'): boolean => (typeof candidate[key] === 'boolean' ? candidate[key] : DEFAULTS[key])
    const workers = candidate.highlightWorkers
    return {
      plugins: parsePluginChoices(candidate),
      theme: candidate.theme === 'system' || isThemeId(candidate.theme) ? candidate.theme : DEFAULTS.theme,
      diffStyle: candidate.diffStyle === 'unified' ? 'unified' : 'split',
      sections: candidate.sections === 'expanded' ? 'expanded' : 'hidden',
      bottomPanel: candidate.bottomPanel === 'full' ? 'full' : 'content',
      sidebarBranches: candidate.sidebarBranches === true,
      opacity: clampOpacity(candidate.opacity),
      borderStrength: BORDER_STRENGTHS.find((strength) => strength === candidate.borderStrength) ?? DEFAULTS.borderStrength,
      hotkey: 'hotkey' in candidate ? parseHotkey(candidate.hotkey) : DEFAULTS.hotkey,
      hotkeyHideOnBlur: flag('hotkeyHideOnBlur'),
      hotkeyOnly: flag('hotkeyOnly'),
      navigationKeys: parseNavigationKeys(candidate.navigationKeys),
      digitShortcuts: parseDigitShortcuts(candidate.digitShortcuts),
      editorFontSize: clampFontSize(candidate.editorFontSize, DEFAULTS.editorFontSize),
      terminalFontSize: clampFontSize(candidate.terminalFontSize, DEFAULTS.terminalFontSize),
      terminalScrollback: clampScrollback(candidate.terminalScrollback),
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
const listeners = new Set<() => void>()

export const getSettings = (): Settings => settings

export function updateSettings(patch: Partial<Settings>): void {
  settings = { ...settings, ...patch }
  localStorage.setItem(KEY, JSON.stringify(settings))
  listeners.forEach((listener) => listener())
}

export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const useSettings = (): Settings => useSyncExternalStore(subscribeSettings, () => settings)

// Absent outside the renderer (bun tests), where 'system' resolves to dark
const systemDark = typeof window === 'undefined' ? null : window.matchMedia('(prefers-color-scheme: dark)')

/** The theme actually shown, resolving 'system' against the macOS appearance */
export const activeTheme = (): ThemeId => (settings.theme !== 'system' ? settings.theme : (systemDark?.matches ?? true) ? 'neutral' : 'light')

// A new settings object makes useSettings consumers re-render when the appearance flips under 'system'
systemDark?.addEventListener('change', () => {
  if (settings.theme !== 'system') return
  settings = { ...settings }
  listeners.forEach((listener) => listener())
})

/** Folder groups follow the sections setting; `toggled` holds the ones the user flipped */
export const groupOpen = (toggled: Set<string>, key: string): boolean => (getSettings().sections === 'expanded') !== toggled.has(key)

export function toggleIn(set: Set<string>, key: string): Set<string> {
  const next = new Set(set)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}
