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
}

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
  // Vercel's Geist dark: black canvas, raised grays, their blue for actions
  vercel: {
    label: 'Vercel',
    mode: 'dark',
    background: '#000000',
    card: '#0a0a0a',
    popover: '#1a1a1a',
    foreground: '#ededed',
    mutedForeground: '#a1a1a1',
    primary: '#0070f3'
  },
  // Still black, one step up from Neutral
  onyx: {
    label: 'Onyx',
    mode: 'dark',
    background: '#0a0a0a',
    card: '#0a0a0a',
    popover: '#171717',
    foreground: '#f2f2f2',
    mutedForeground: '#8a8a8a',
    primary: '#4f5ff0'
  },
  // Two steps up: near black with a soft lift
  coal: {
    label: 'Coal',
    mode: 'dark',
    background: '#131313',
    card: '#131313',
    popover: '#1f1f1f',
    foreground: '#eeeeee',
    mutedForeground: '#8f8f8f',
    primary: '#4f5ff0'
  },
  midnight: {
    label: 'Midnight',
    mode: 'dark',
    background: '#0b0e14',
    card: '#10141c',
    popover: '#171c27',
    foreground: '#e6e9ef',
    mutedForeground: '#7f8898',
    primary: '#5b7cfa'
  },
  graphite: {
    label: 'Graphite',
    mode: 'dark',
    background: '#161616',
    card: '#1d1d1d',
    popover: '#262626',
    foreground: '#ededed',
    mutedForeground: '#909090',
    primary: '#10a37f'
  },
  nord: {
    label: 'Nord',
    mode: 'dark',
    background: '#242933',
    card: '#2e3440',
    popover: '#3b4252',
    foreground: '#eceff4',
    mutedForeground: '#9aa3b5',
    primary: '#5e81ac'
  },
  dracula: {
    label: 'Dracula',
    mode: 'dark',
    background: '#1e1f29',
    card: '#282a36',
    popover: '#343746',
    foreground: '#f8f8f2',
    mutedForeground: '#8e92ad',
    primary: '#9d6ff0'
  },
  solarized: {
    label: 'Solarized',
    mode: 'dark',
    background: '#001e26',
    card: '#002b36',
    popover: '#073642',
    foreground: '#eee8d5',
    mutedForeground: '#839496',
    primary: '#268bd2'
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

export type ThemeId = keyof typeof THEMES

export const isThemeId = (value: unknown): value is ThemeId => typeof value === 'string' && Object.hasOwn(THEMES, value)

/** `#rrggbb` to an rgb() color with the given 0-1 alpha */
export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16))
  return alpha >= 1 ? hex : `rgb(${r} ${g} ${b} / ${Math.round(alpha * 100)}%)`
}

/** Overrides the Tailwind color tokens, so every bg-card or text-foreground utility follows the theme */
/** `borderStrength` scales hairlines and input outlines, 0-1 */
export function applyTheme(id: ThemeId, opacity: number, borderStrength = 1): void {
  const theme: Theme = THEMES[id]
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

export const themeMode = (id: ThemeId): Theme['mode'] => THEMES[id].mode

/** Shiki theme matching the app theme, for code outside @pierre/diffs components */
export const codeTheme = (id: ThemeId): 'pierre-dark' | 'pierre-light' => (THEMES[id].mode === 'light' ? 'pierre-light' : 'pierre-dark')
