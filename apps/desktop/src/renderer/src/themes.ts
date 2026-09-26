import { getResolvedOrResolveTheme, registerCustomTheme, type ThemeRegistration } from '@pierre/diffs'

export type Theme = {
  label: string
  mode: 'dark' | 'light'
  background: string
  card: string
  /** Lists and the workspace rail; defaults to card */
  sidebar?: string
  popover: string
  foreground: string
  mutedForeground: string
  primary: string
  /** Code colors and the terminal palette: a shiki theme name like github-light, or a VS Code color theme; defaults to Pierre */
  syntax?: string | ThemeRegistration
}

/** Always there, whatever plugins are on: the fallback for each mode */
export const THEMES = {
  neutral: {
    label: 'Neutral',
    mode: 'dark',
    // One black surface everywhere, like T3 Code's sidebar; hairlines separate the areas and menus sit a step above
    background: '#000000',
    card: '#000000',
    popover: '#121212',
    foreground: '#f5f5f5',
    mutedForeground: '#848484',
    primary: '#4f5ff0'
  },
  light: {
    label: 'Light',
    mode: 'light',
    background: '#ffffff',
    card: '#f6f6f7',
    popover: '#ffffff',
    foreground: '#1b1b1f',
    mutedForeground: '#6b6b73',
    primary: '#4f5ff0'
  }
} satisfies Record<string, Theme>

export const DEFAULT_THEME = { dark: 'neutral', light: 'light' } as const satisfies Record<Theme['mode'], keyof typeof THEMES>

let pluginThemes: Record<string, Theme> = {}
const listeners = new Set<() => void>()
const notify = (): void => listeners.forEach((listener) => listener())

/** Themes contributed by enabled plugins, replacing the previous set */
export function setPluginThemes(themes: Record<string, Theme>): void {
  pluginThemes = themes
  notify()
}

export function subscribeThemes(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Every theme on offer, built-in first */
export const allThemes = (): [string, Theme][] => [...Object.entries(THEMES), ...Object.entries(pluginThemes), ...Object.entries(customThemes)]

const LAST_KEY = 'theme.last'
/** The last theme painted, so a plugin theme shows at startup before its plugin has loaded */
const lastApplied = ((): { id: string; theme: Theme } | null => {
  try {
    const parsed: unknown = typeof localStorage === 'undefined' ? null : JSON.parse(localStorage.getItem(LAST_KEY) ?? 'null')
    return typeof parsed === 'object' && parsed !== null && 'id' in parsed && 'theme' in parsed ? (parsed as { id: string; theme: Theme }) : null
  } catch {
    return null
  }
})()

/** A theme by id; one whose plugin is off (or not loaded yet) falls back to the built-in theme of that mode */
export function resolveTheme(id: string, mode: Theme['mode']): Theme {
  const found: Theme | undefined = Object.hasOwn(THEMES, id) ? THEMES[id as keyof typeof THEMES] : (pluginThemes[id] ?? customThemes[id])
  if (found?.mode === mode) return found
  if (!found && lastApplied?.id === id && lastApplied.theme.mode === mode) return lastApplied.theme
  return THEMES[DEFAULT_THEME[mode]]
}

/** `#rrggbb` to an rgb() color with the given 0-1 alpha */
export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16))
  return alpha >= 1 ? hex : `rgb(${r} ${g} ${b} / ${Math.round(alpha * 100)}%)`
}

/** Overrides the Tailwind color tokens, so every bg-card or text-foreground utility follows the theme */
/** `borderStrength` scales hairlines and input outlines, 0-1 */
export function applyTheme(id: string, theme: Theme, opacity: number, borderStrength = 1): void {
  localStorage.setItem(LAST_KEY, JSON.stringify({ id, theme }))
  const root = document.documentElement.style
  root.setProperty('--color-background', withAlpha(theme.background, opacity))
  root.setProperty('--color-card', withAlpha(theme.card, opacity))
  root.setProperty('--color-sidebar', withAlpha(theme.sidebar ?? theme.card, opacity))
  // Menus stay mostly solid so their text reads over busy content
  root.setProperty('--color-popover', withAlpha(theme.popover, Math.max(opacity, 0.92)))
  root.setProperty('--color-foreground', theme.foreground)
  root.setProperty('--color-muted-foreground', theme.mutedForeground)
  root.setProperty('--color-primary', theme.primary)
  // Hairlines and hover fills are the foreground at low alpha, so they flip with the mode
  const tint = theme.mode === 'light' ? '0 0 0' : '255 255 255'
  root.setProperty('--color-border', `rgb(${tint} / ${(theme.mode === 'light' ? 10 : 6) * borderStrength}%)`)
  root.setProperty('--color-input', `rgb(${tint} / ${(theme.mode === 'light' ? 14 : 8) * borderStrength}%)`)
  root.setProperty('--color-accent', `rgb(${tint} / ${theme.mode === 'light' ? 5 : 4}%)`)
  root.setProperty('--color-muted', `rgb(${tint} / ${theme.mode === 'light' ? 4 : 3}%)`)
  root.colorScheme = theme.mode
  document.documentElement.dataset.mode = theme.mode
}

const pierreTheme = (mode: Theme['mode']): string => (mode === 'light' ? 'pierre-light' : 'pierre-dark')
const registeredSyntax = new Set<string>()

/** Shiki theme name for the app theme's code; an embedded VS Code theme registers under its own name on first use */
export function codeTheme(theme: Theme): string {
  const { syntax } = theme
  if (typeof syntax === 'string') return syntax
  if (!syntax?.name) return pierreTheme(theme.mode)
  const { name } = syntax
  if (!registeredSyntax.has(name)) {
    registeredSyntax.add(name)
    registerCustomTheme(name, () => Promise.resolve({ ...syntax, name, type: theme.mode }))
  }
  return name
}

const ANSI = ['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White'] as const

/** xterm's ANSI colors from the code theme's terminal colors, Pierre's filling in any it lacks */
export async function terminalPalette(theme: Theme): Promise<Record<string, string>> {
  const [base, own] = await Promise.all([getResolvedOrResolveTheme(pierreTheme(theme.mode)), getResolvedOrResolveTheme(codeTheme(theme))])
  const colors: Record<string, string | undefined> = { ...base.colors, ...own.colors }
  return Object.fromEntries(
    ANSI.flatMap((name) => [
      [name.toLowerCase(), colors[`terminal.ansi${name}`]],
      [`bright${name}`, colors[`terminal.ansiBright${name}`]]
    ]).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
}

function saveCustomThemes(themes: Record<string, Theme>): void {
  customThemes = themes
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(themes))
  notify()
}

export const isCustomTheme = (id: string): boolean => Object.hasOwn(customThemes, id)

/** Adds an imported theme and returns its id; ids are never reused, so a stale registered syntax theme can't shadow a new one */
export function addCustomTheme(theme: Theme): string {
  const id = `custom-${Date.now().toString(36)}`
  const syntax = typeof theme.syntax === 'object' ? { ...theme.syntax, name: id } : theme.syntax
  saveCustomThemes({ ...customThemes, [id]: { ...theme, syntax } })
  return id
}

export function removeCustomTheme(id: string): void {
  const { [id]: _removed, ...rest } = customThemes
  saveCustomThemes(rest)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `#rgb`, `#rrggbb` or `#rrggbbaa` as `#rrggbb`; alpha is dropped since surfaces take the window opacity */
function hex(value: unknown): string | null {
  if (typeof value !== 'string' || !/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) return null
  return value.length === 4 ? `#${[...value.slice(1)].map((digit) => digit + digit).join('')}` : value.slice(0, 7)
}

const SURFACE_KEYS = ['background', 'card', 'popover', 'foreground', 'mutedForeground', 'primary'] as const

/** The app's own theme shape, as exported or written by hand */
function ownTheme(json: Record<string, unknown>): Theme | null {
  if (json.mode !== 'light' && json.mode !== 'dark') return null
  const colors = SURFACE_KEYS.map((key) => hex(json[key]))
  if (colors.some((color) => color === null)) return null
  const [background, card, popover, foreground, mutedForeground, primary] = colors as string[]
  const sidebar = hex(json.sidebar) ?? undefined
  const syntax = typeof json.syntax === 'string' || isRecord(json.syntax) ? (json.syntax as Theme['syntax']) : undefined
  const label = typeof json.label === 'string' && json.label ? json.label : 'Imported'
  return { label, mode: json.mode, background, card, sidebar, popover, foreground, mutedForeground, primary, syntax }
}

/** A VS Code color theme: surfaces from its workbench colors, code colors from its token colors */
function vscodeTheme(json: Record<string, unknown>): Theme | null {
  const colors = isRecord(json.colors) ? json.colors : {}
  const pick = (...keys: string[]): string | null => keys.map((key) => hex(colors[key])).find((color) => color !== null) ?? null
  const background = pick('editor.background')
  const foreground = pick('editor.foreground', 'foreground')
  if (!background || !foreground) return null
  const mode: Theme['mode'] = json.type === 'light' || json.type === 'hc-light' ? 'light' : 'dark'
  const card = pick('sideBar.background') ?? background
  return {
    label: typeof json.name === 'string' && json.name ? json.name : 'Imported',
    mode,
    background,
    card,
    popover: pick('editorWidget.background', 'dropdown.background') ?? card,
    foreground,
    mutedForeground: pick('descriptionForeground', 'editorLineNumber.foreground') ?? foreground,
    primary: pick('button.background', 'focusBorder', 'textLink.foreground') ?? THEMES[DEFAULT_THEME[mode]].primary,
    syntax: Array.isArray(json.tokenColors) ? (json as ThemeRegistration) : undefined
  }
}

/** VS Code theme files are JSONC: drop comments and trailing commas outside strings */
const stripJsonc = (text: string): string => text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\/|,(?=\s*[}\]])/g, (_match, string?: string) => string ?? '')

/** A theme file, in the app's own shape or a VS Code color theme */
export function parseThemeFile(text: string): Theme | null {
  let json: unknown
  try {
    json = JSON.parse(stripJsonc(text))
  } catch {
    return null
  }
  return isRecord(json) ? (ownTheme(json) ?? vscodeTheme(json)) : null
}

const CUSTOM_KEY = 'themes.custom'
let customThemes: Record<string, Theme> = ((): Record<string, Theme> => {
  try {
    const parsed: unknown = typeof localStorage === 'undefined' ? null : JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? '{}')
    if (!isRecord(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).flatMap(([id, value]) => (isRecord(value) && ownTheme(value) ? [[id, ownTheme(value)!]] : [])))
  } catch {
    return {}
  }
})()
