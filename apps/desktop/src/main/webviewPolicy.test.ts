import { expect, test } from 'bun:test'
import { allowsPermission, BROWSER_PARTITION, hardenWebview } from './webviewPolicy'

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
    preload: '/app/out/preload/browserInject.js',
    transparent: false
  })
})

test('allowsPermission grants only full screen and sanitized clipboard writes', () => {
  expect(allowsPermission('fullscreen')).toBe(true)
  expect(allowsPermission('clipboard-sanitized-write')).toBe(true)
  for (const permission of ['notifications', 'geolocation', 'media', 'midi', 'pointerLock', 'openExternal', 'clipboard-read']) expect(allowsPermission(permission)).toBe(false)
})
