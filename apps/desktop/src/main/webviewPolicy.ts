import type { WebPreferences } from 'electron'

/** Session of every page in the built-in browser, apart from the app's own */
export const BROWSER_PARTITION = 'persist:browser'

/** A page can't ask for more than a plain browser tab gets; whatever the renderer set is replaced */
export function hardenWebview(prefs: WebPreferences | Record<string, unknown>, injectPath: string): void {
  const target = prefs as Record<string, unknown>
  for (const key of Object.keys(target)) delete target[key]
  Object.assign(target, {
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    partition: BROWSER_PARTITION,
    preload: injectPath
  })
}
