import { Terminal, type ITheme } from '@xterm/xterm'
import type { ISearchDecorationOptions } from '@xterm/addon-search'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import './terminal.css'
import { type Renderer, wantsWebgl } from './renderer'
import { settingsNow } from '../../features/agents/settings'

export const IS_MAC = /Mac/.test(navigator.userAgent)
const IS_LINUX = /Linux/.test(navigator.userAgent)

/** Lost WebGL contexts in this window, counted across reveals */
let webglLosses = 0

export const webglFor = (renderer: Renderer): boolean => wantsWebgl(renderer, IS_LINUX, webglLosses)

const ANSI_NAMES = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
] as const

/**
 * Theme and font from CSS custom properties, defaults in terminal.css:
 * --term-bg (--xterm-bg overrides it for a see-through canvas), --term-fg, --term-cursor, --term-selection, --term-font, --term-font-size, and ANSI colors --term-0 .. --term-15
 */
function cssTheme(host: HTMLElement): { theme: ITheme; allowTransparency: boolean; fontFamily: string; fontSize: number } {
  const style = getComputedStyle(host)
  const read = (name: string): string | undefined => style.getPropertyValue(name).trim() || undefined
  const theme: ITheme = {
    background: read('--xterm-bg') ?? read('--term-bg'),
    foreground: read('--term-fg'),
    cursor: read('--term-cursor'),
    selectionBackground: read('--term-selection')
  }
  ANSI_NAMES.forEach((name, index) => (theme[name] = read(`--term-${index}`)))
  return { theme, allowTransparency: read('--xterm-bg') !== undefined, fontFamily: read('--term-font') ?? 'monospace', fontSize: Number(read('--term-font-size')) || 12 }
}

/** Find highlights from --term-match and --term-match-active; decorations take #RRGGBB only */
export function searchDecorations(host: HTMLElement): ISearchDecorationOptions {
  const style = getComputedStyle(host)
  const match = style.getPropertyValue('--term-match').trim()
  const active = style.getPropertyValue('--term-match-active').trim()
  return { matchBackground: match, matchOverviewRuler: match, activeMatchBackground: active, activeMatchColorOverviewRuler: active }
}

const LINE_HEIGHT = 1.15

/** The CSS tokens plus Settings > Terminal, defaults until the settings load */
function look(host: HTMLElement) {
  const terminal = settingsNow()?.terminal
  return {
    ...cssTheme(host),
    lineHeight: terminal?.lineHeight ?? LINE_HEIGHT,
    cursorStyle: terminal?.cursorStyle ?? ('bar' as const),
    cursorBlink: terminal?.cursorBlink ?? true,
    scrollback: terminal?.scrollback ?? 5000,
    // Off by default: Option types characters like ą and ś; word jumps are mapped in keys.ts
    macOptionIsMeta: terminal?.optionAsMeta ?? false
  }
}
/** What a pane's header (.phd) and the xterm padding take from its box */
const PANE_CHROME = { width: 8, height: 30 }

/** The grid a pane of `width` x `height` px fits, a column short: a shell's first prompt must not wrap
 * (zsh's PROMPT_SP mark would stay on screen) before the pane resizes the session to the exact grid */
export function paneGrid(width: number, height: number): { cols: number; rows: number } {
  const { fontFamily, fontSize } = cssTheme(document.documentElement)
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx || width <= 0 || height <= 0) return { cols: 80, rows: 24 }
  ctx.font = `${fontSize}px ${fontFamily}`
  return {
    cols: Math.max(2, Math.floor((width - PANE_CHROME.width) / ctx.measureText('W').width) - 1),
    rows: Math.max(1, Math.floor((height - PANE_CHROME.height) / Math.ceil(fontSize * (settingsNow()?.terminal.lineHeight ?? LINE_HEIGHT))))
  }
}

export interface Xterm {
  term: Terminal
  fit: FitAddon
  search: SearchAddon
  /** Re-reads the theme, font and terminal settings; a no-op when they didn't change */
  restyle(): void
  dispose(): void
}

/** An xterm with the app's addons opened in `host`; the GPU context lives exactly as long as it does */
export function openXterm(host: HTMLElement, webgl: boolean): Xterm {
  const style = look(host)
  let applied = JSON.stringify(style)
  const term = new Terminal({
    ...style,
    cursorWidth: 2,
    // unicode11 registers through the proposed unicode API
    allowProposedApi: true
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  const search = new SearchAddon()
  term.loadAddon(search)
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'
  // ponytail: opens in the system browser via window.open, route through the app's link handling once it exists
  term.loadAddon(new WebLinksAddon((_, uri) => window.open(uri, '_blank')))
  term.open(host)
  let gl: WebglAddon | null = null
  if (webgl) {
    try {
      const addon = new WebglAddon()
      // A lost context (GPU reset, too many contexts) falls back to the DOM renderer until the next reveal
      addon.onContextLoss(() => {
        webglLosses++
        addon.dispose()
        gl = null
      })
      term.loadAddon(addon)
      gl = addon
    } catch {
      // No WebGL2 here: the DOM renderer stays
    }
  }
  fit.fit()
  return {
    term,
    fit,
    search,
    restyle() {
      const next = look(host)
      const key = JSON.stringify(next)
      if (key === applied) return
      applied = key
      Object.assign(term.options, next)
      fit.fit()
    },
    dispose() {
      const canvases = gl ? [...host.querySelectorAll('canvas')] : []
      term.dispose()
      // The addon leaves its context to GC, and WebKit caps live contexts per page, so it is released now
      for (const canvas of canvases) canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }
}
