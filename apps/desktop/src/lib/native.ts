/** Desktop-only calls; the browser build (mock api) gets a stand-in for each */
export const IN_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/** The browser mock's demo folder, a plain folder that exists in its fake file system */
const DEMO_FOLDER = 'projects/landing'

/** A folder from the system picker, null when cancelled */
export async function pickFolder(home: string): Promise<string | null> {
  if (!IN_TAURI) return `${home}/${DEMO_FOLDER}`
  const { open } = await import('@tauri-apps/plugin-dialog')
  const dir = await open({ directory: true, defaultPath: home })
  return typeof dir === 'string' ? dir : null
}

/** Registers the quick terminal's global chord (null: none); rejects with the plugin's message when the chord is taken */
export async function registerQuickShortcut(accelerator: string | null): Promise<void> {
  if (!IN_TAURI) return
  const { commands } = await import('../ipc/bindings')
  await commands.setQuickShortcut(accelerator)
}

/** Page zoom of this window; the browser build zooms the page with CSS */
export async function setZoom(scale: number): Promise<void> {
  if (!IN_TAURI) return void (document.documentElement.style.zoom = String(scale))
  const { getCurrentWebview } = await import('@tauri-apps/api/webview')
  await getCurrentWebview().setZoom(scale)
}

/** App event the main window sends when theme, density, renderer or zoom change, so the quick terminal follows live */
export const UI_CHANGED = 'ui-changed'
