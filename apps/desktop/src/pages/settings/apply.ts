import { useEffect, useEffectEvent, useLayoutEffect } from 'react'
import { useSettings } from '../../features/agents/settings'
import { THEMES } from '../../features'
import type { Api, Settings } from '../../ipc/api'
import type { Mode } from '../../styles/theme'

/** A CSS font-family: the name quoted, CSS keywords like `ui-monospace` as they are, then the fallback */
export function fontStack(family: string, fallback: string): string {
  const name = family.trim().replace(/["\\]/g, '')
  if (!name) return fallback
  return `${/^(ui-[a-z-]+|system-ui|monospace|-apple-system)$/.test(name) ? name : `"${name}"`}, ${fallback}`
}

/** The custom properties a theme sets; the first theme of each mode is the stylesheet's own and sets none, an unknown name falls back to it */
export function themeVars(mode: Mode, name: string): Record<string, string> {
  const list = THEMES[mode]
  const theme = list.find(([n]) => n === name)
  if (!theme || theme === list[0]) return {}
  const [, background, primary] = theme
  return {
    '--background': background,
    '--primary': primary,
    '--popover': `color-mix(in srgb, var(--foreground) ${mode === 'light' ? 0 : 7}%, ${background})`,
    '--term-bg': background,
  }
}

const THEME_VARS = ['--background', '--primary', '--popover', '--term-bg']

function apply(settings: Settings, mode: Mode) {
  const style = document.documentElement.style
  const vars = themeVars(mode, mode === 'light' ? settings.appearance.lightTheme : settings.appearance.darkTheme)
  for (const name of THEME_VARS) {
    const value = vars[name]
    if (value) style.setProperty(name, value)
    else style.removeProperty(name)
  }
  style.setProperty('--term-font', fontStack(settings.terminal.fontFamily, "ui-monospace, 'SF Mono', Menlo, monospace"))
  style.setProperty('--term-font-size', String(settings.terminal.fontSize))
  // Terminals and editors re-read the tokens
  window.dispatchEvent(new Event('treeix-theme'))
}

const DARK = '(prefers-color-scheme: dark)'

/**
 * Applies the saved theme, terminal font and size to this window and keeps them live. With follow-system on, `setMode`
 * gets the OS mode now and on every change
 */
export function useAppliedSettings(api: Api, mode: Mode, setMode: (mode: Mode) => void) {
  const settings = useSettings(api)
  useLayoutEffect(() => {
    if (settings) apply(settings, mode)
  }, [settings, mode])
  const follow = settings?.appearance.followSystem ?? false
  const toOs = useEffectEvent((dark: boolean) => setMode(dark ? 'dark' : 'light'))
  useEffect(() => {
    if (!follow) return
    const query = matchMedia(DARK)
    const sync = () => toOs(query.matches)
    sync()
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [follow])
}
