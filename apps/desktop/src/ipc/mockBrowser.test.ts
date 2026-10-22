import { expect, test } from 'bun:test'
import { browserMock, browserUrl } from './mockBrowser'

test('the address bar keeps URLs, adds a scheme to hosts and searches the rest', () => {
  expect(browserUrl('https://example.com/a')).toBe('https://example.com/a')
  expect(browserUrl('localhost:5173/x')).toBe('http://localhost:5173/x')
  expect(browserUrl('github.com/treeix')).toBe('https://github.com/treeix')
  expect(browserUrl('rust tauri webview', 'https://duckduckgo.com/?q=%s')).toBe('https://duckduckgo.com/?q=rust%20tauri%20webview')
})

test('a pane opened without a URL shows the start page until it navigates', async () => {
  const api = browserMock()
  expect((await api.browserOpen('p', '')).url).toBe('')
  await api.browserNavigate('p', 'localhost:5173')
  expect((await api.browserOpen('p', '')).url).toBe('http://localhost:5173')
})
