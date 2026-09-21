import { expect, test } from 'bun:test'
import { BROWSER_PARTITION, hardenWebview } from './webviewPolicy'

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
