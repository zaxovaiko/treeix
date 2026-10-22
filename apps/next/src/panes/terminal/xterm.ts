import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import './terminal.css'

export const IS_MAC = /Mac/.test(navigator.userAgent)

/** WebGL on macOS; Linux WebKitGTK often falls back to software GL, so it draws with the DOM renderer unless opted in */
const useWebgl = (): boolean => !/Linux/.test(navigator.userAgent) || localStorage.getItem('treeix.webgl') === '1'

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
 * --term-bg, --term-fg, --term-cursor, --term-selection, --term-font, --term-font-size, and ANSI colors --term-0 .. --term-15
 */
function cssTheme(host: HTMLElement): { theme: ITheme; fontFamily: string; fontSize: number } {
  const style = getComputedStyle(host)
  const read = (name: string): string | undefined => style.getPropertyValue(name).trim() || undefined
  const theme: ITheme = {
    background: read('--term-bg'),
    foreground: read('--term-fg'),
    cursor: read('--term-cursor'),
    selectionBackground: read('--term-selection')
  }
  ANSI_NAMES.forEach((name, index) => (theme[name] = read(`--term-${index}`)))
  return { theme, fontFamily: read('--term-font') ?? 'monospace', fontSize: Number(read('--term-font-size')) || 12 }
}

export interface Xterm {
  term: Terminal
  fit: FitAddon
  /** Re-reads the theme and font from CSS */
  restyle(): void
  dispose(): void
}

/** An xterm with the app's addons opened in `host`; the GPU context lives exactly as long as it does */
export function openXterm(host: HTMLElement, webgl = useWebgl()): Xterm {
  const { theme, fontFamily, fontSize } = cssTheme(host)
  const term = new Terminal({
    theme,
    fontFamily,
    fontSize,
    lineHeight: 1.15,
    cursorBlink: true,
    cursorStyle: 'bar',
    cursorWidth: 2,
    // Opaque canvas: no blend tricks needed under a see-through window
    allowTransparency: false,
    // Option types characters like ą and ś; word jumps are mapped in keys.ts
    macOptionIsMeta: false,
    scrollback: 5000,
    // unicode11 registers through the proposed unicode API
    allowProposedApi: true
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'
  // ponytail: opens in the system browser via window.open, route through the app's link handling once it exists
  term.loadAddon(new WebLinksAddon((_, uri) => window.open(uri, '_blank')))
  term.open(host)
  let gl: WebglAddon | null = null
  if (webgl) {
    try {
      const addon = new WebglAddon()
      // A lost context (GPU reset, too many contexts) falls back to the DOM renderer for the rest of this terminal's life
      addon.onContextLoss(() => {
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
    restyle() {
      Object.assign(term.options, cssTheme(host))
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
