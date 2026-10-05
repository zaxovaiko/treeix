import type { Session, WebPreferences } from 'electron'

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
    preload: injectPath,
    // Guests are see-through by default, so a page that leaves its background to the browser showed the app's dark theme under dark text
    transparent: false
  })
}

const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write'])

/** Electron grants every permission by default; pages get none that would need a prompt in Chrome */
export const allowsPermission = (permission: string): boolean => ALLOWED_PERMISSIONS.has(permission)

// The user agent stays Electron's own: Google sign-in rejects a Chrome one whose client hints lack the Google Chrome brand
export function configureBrowserSession(browser: Session): void {
  browser.setPermissionRequestHandler((_, permission, callback) => callback(allowsPermission(permission)))
  browser.setPermissionCheckHandler((_, permission) => allowsPermission(permission))
}
