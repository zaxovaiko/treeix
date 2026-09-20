import { expect, test } from 'bun:test'

test('panels are remembered per page, and the same key undoes a toggle', async () => {
  const stored = new Map<string, string>()
  globalThis.localStorage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value) } as unknown as Storage
  globalThis.requestAnimationFrame = () => 0
  const { getShell, togglePanel, toggleZen, updateShell } = await import('./layout')
  expect(getShell().status).toBe(false)

  updateShell({ zone: 'list' })
  togglePanel('list', 'prs')
  expect(getShell().pages.prs.list).toBe(false)
  expect(getShell().pages.tasks).toBeUndefined()
  // Hiding the focused list hands focus to main; showing it again focuses it
  expect(getShell().zone).toBe('main')
  togglePanel('list', 'prs')
  expect(getShell().pages.prs.list).toBe(true)
  expect(getShell().zone).toBe('list')

  togglePanel('rail', 'prs')
  expect(JSON.parse(stored.get('shell.panels') ?? '{}')).toMatchObject({ rail: false, pages: { prs: { list: true } } })

  toggleZen()
  expect(getShell().zen).toBe(true)
  togglePanel('inspector', 'prs')
  expect(getShell().zen).toBe(false)
})
