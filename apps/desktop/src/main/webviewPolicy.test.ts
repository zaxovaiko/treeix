import { expect, test } from 'bun:test'
import { allowsPermission, BROWSER_PARTITION, browserUserAgent, hardenWebview } from './webviewPolicy'

test('hardenWebview forces the browser partition, isolation and our preload', () => {
  const prefs: Record<string, unknown> = { nodeIntegration: true, contextIsolation: false, sandbox: false, preload: '/evil.js', partition: 'persist:app', webSecurity: false }
  hardenWebview(prefs, '/app/out/preload/browserInject.js')
  expect(prefs).toEqual({
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    partition: BROWSER_PARTITION,
    preload: '/app/out/preload/browserInject.js'
  })
})

test('browserUserAgent is the stock Chrome UA without the Electron and app tokens', () => {
  const electron = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) treeix/0.4.0 Chrome/142.0.7444.52 Electron/39.1.0 Safari/537.36'
  expect(browserUserAgent(electron, 'Treeix')).toBe('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.52 Safari/537.36')
})

test('allowsPermission grants only full screen and sanitized clipboard writes', () => {
  expect(allowsPermission('fullscreen')).toBe(true)
  expect(allowsPermission('clipboard-sanitized-write')).toBe(true)
  for (const permission of ['notifications', 'geolocation', 'media', 'midi', 'pointerLock', 'openExternal', 'clipboard-read']) expect(allowsPermission(permission)).toBe(false)
})
