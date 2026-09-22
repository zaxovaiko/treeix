import { expect, test } from 'bun:test'
import type { Command } from './CommandPalette'
import { fuzzy, paletteResults } from './paletteSearch'

const command = (group: string, label: string, detail?: string): Command => ({ id: `${group}:${label}`, group, label, detail, run: () => undefined })
const commands = [
  command('Actions', 'Toggle list'),
  command('Actions', 'Open settings'),
  command('Pull requests', '#42 Fix login redirect', 'web'),
  command('Files', 'index.ts', 'src/renderer'),
  command('Settings', 'Transparency', 'Appearance / Window')
]
const labels = (query: string): string[] => paletteResults(commands, query).map((result) => result.command.label)

test('fuzzy matches letters in order and prefers runs and word starts', () => {
  expect(fuzzy('tl', 'Toggle list')?.marks).toEqual([0, 4])
  expect(fuzzy('xyz', 'Toggle list')).toBeNull()
  expect(fuzzy('set', 'Open settings')?.score ?? 0).toBeGreaterThan(fuzzy('set', 'Some extra text')?.score ?? 0)
})

test('palette browses actions, searches every group and narrows by prefix', () => {
  // Files and Settings wait for a query
  expect(labels('')).toEqual(['Toggle list', 'Open settings', '#42 Fix login redirect'])
  expect(labels('login')).toEqual(['#42 Fix login redirect'])
  expect(labels('src/renderer index')).toEqual(['index.ts'])
  expect(labels(':')).toEqual(['Transparency'])
  expect(labels('#fix')).toEqual(['#42 Fix login redirect'])
  expect(labels('>fix')).toEqual([])
})

test('a word typed out whole beats the same letters scattered across a longer label', () => {
  const results = paletteResults([command('Shortcuts', 'Close the focused pane to History; the last pane closes its tab'), command('Actions', 'Close split (terminal)')], 'close split')
  expect(results[0].command.label).toBe('Close split (terminal)')
})
