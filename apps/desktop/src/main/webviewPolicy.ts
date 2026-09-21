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
    preload: injectPath
  })
}

const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write'])

/** Electron grants every permission by default; pages get none that would need a prompt in Chrome */
export const allowsPermission = (permission: string): boolean => ALLOWED_PERMISSIONS.has(permission)

/** Sites like Google sign-in turn away embedded browsers, so pages see the stock Chrome user agent */
export const browserUserAgent = (fallback: string, appName: string): string =>
  fallback
    .split(' ')
    .filter((token) => !/^electron\//i.test(token) && !token.toLowerCase().startsWith(`${appName.toLowerCase()}/`))
    .join(' ')

export function configureBrowserSession(browser: Session, userAgentFallback: string, appName: string): void {
  browser.setPermissionRequestHandler((_, permission, callback) => callback(allowsPermission(permission)))
  browser.setPermissionCheckHandler((_, permission) => allowsPermission(permission))
  browser.setUserAgent(browserUserAgent(userAgentFallback, appName))
}
