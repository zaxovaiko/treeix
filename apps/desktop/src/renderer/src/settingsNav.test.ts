import { expect, test } from 'bun:test'
import { navRows, openablePage, isPageId, onSettingsPage, showSettingsPage, takeRequestedPage } from './settingsNav'
import type { LoadedPlugin, PluginEntry } from './plugins'

const entry = (id: string, name: string): PluginEntry => ({ manifest: { id, name, description: '', enabledByDefault: true }, load: null })
const loaded = (id: string, name: string, hasSettings: boolean): LoadedPlugin =>
  ({ manifest: entry(id, name).manifest, plugin: hasSettings ? { Settings: () => null } : {} }) as LoadedPlugin

const PLUGINS = [entry('terminal', 'Terminal'), entry('pull-requests', 'Pull requests'), entry('keep-awake', 'Keep awake')]

test('only a loaded plugin with settings of its own gets a row, in the plugin list order', () => {
  const rows = navRows(PLUGINS, [loaded('keep-awake', 'Keep awake', true), loaded('pull-requests', 'Pull requests', true), loaded('terminal', 'Terminal', false)])
  expect(rows.map((row) => row.page)).toEqual([
    'General',
    'Appearance',
    'Terminal',
    'Keyboard',
    'Plugins',
    'plugin:pull-requests',
    'plugin:keep-awake',
    'Integrations'
  ])
  expect(rows.filter((row) => row.child).map((row) => row.label)).toEqual(['Pull requests', 'Keep awake'])
})

test('the six sections stand alone when no loaded plugin brings settings', () => {
  const rows = navRows(PLUGINS, [loaded('terminal', 'Terminal', false)])
  expect(rows).toHaveLength(6)
  expect(rows.some((row) => row.child)).toBe(false)
})

test('a remembered page falls back to the plugin list once its plugin is switched off', () => {
  const on = navRows(PLUGINS, [loaded('keep-awake', 'Keep awake', true)])
  const off = navRows(PLUGINS, [])
  expect(openablePage('plugin:keep-awake', on)).toBe('plugin:keep-awake')
  expect(openablePage('plugin:keep-awake', off)).toBe('Plugins')
  expect(openablePage('Appearance', off)).toBe('Appearance')
})

test('showSettingsPage waits for a closed Settings and goes straight to an open one', () => {
  showSettingsPage('plugin:usage-limits')
  expect(takeRequestedPage()).toBe('plugin:usage-limits')
  expect(takeRequestedPage()).toBeNull()
  const seen: string[] = []
  const stop = onSettingsPage((page) => seen.push(page))
  showSettingsPage('Terminal')
  stop()
  expect(seen).toEqual(['Terminal'])
  expect(takeRequestedPage()).toBeNull()
  expect(isPageId('plugin:browser')).toBe(true)
  expect(isPageId('Nope')).toBe(false)
})
