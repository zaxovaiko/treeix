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

/** Registers the global chord (null: none) that shows and hides the main window; rejects with the plugin's message when the chord is taken */
export async function registerHotkey(accelerator: string | null): Promise<void> {
  if (!IN_TAURI) return
  const { commands } = await import('../ipc/bindings')
  await commands.setHotkey(accelerator)
}

/** Whether what shows through this window's translucent background is blurred */
export async function setWindowBlur(blur: boolean): Promise<void> {
  if (!IN_TAURI) return
  const { commands } = await import('../ipc/bindings')
  await commands.setWindowBlur(blur)
}

/** Page zoom of this window; the browser build zooms the page with CSS */
export async function setZoom(scale: number): Promise<void> {
  if (!IN_TAURI) return void (document.documentElement.style.zoom = String(scale))
  const { getCurrentWebview } = await import('@tauri-apps/api/webview')
  await getCurrentWebview().setZoom(scale)
}

const MENU = 'menu'

/** Menu bar items (src-tauri/src/menu.rs) sent to this window, the one in front when they fired; returns the stop */
export function onMenuItem(run: (id: string) => void): () => void {
  if (!IN_TAURI) return () => {}
  const stop = import('@tauri-apps/api/webviewWindow').then(({ getCurrentWebviewWindow }) => getCurrentWebviewWindow().listen<{ id: string }>(MENU, (e) => run(e.payload.id)))
  return () => void stop.then((off) => off())
}

const OPENED = 'files-opened'

/** Absolute paths of files the system asked Treeix to open (Finder, a file manager): those from before the page loaded, then each as it comes */
export function onOpenedFiles(run: (paths: string[]) => void): () => void {
  if (!IN_TAURI) return () => {}
  const take = () =>
    import('../ipc/bindings')
      .then(({ commands }) => commands.takeOpenedFiles())
      .then((paths) => paths.length > 0 && run(paths))
  void take()
  const stop = import('@tauri-apps/api/webviewWindow').then(({ getCurrentWebviewWindow }) => getCurrentWebviewWindow().listen(OPENED, () => void take()))
  return () => void stop.then((off) => off())
}
