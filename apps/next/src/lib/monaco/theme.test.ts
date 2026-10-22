import { expect, test } from 'bun:test'
import { editorThemeColors, languageFor } from './theme'

test('a path picks its grammar by extension or name', () => {
  expect(languageFor('src/App.tsx')).toBe('tsx')
  expect(languageFor('a/b.mts')).toBe('typescript')
  expect(languageFor('README.md')).toBe('markdown')
  expect(languageFor('docker/Dockerfile')).toBe('docker')
  expect(languageFor('notes.unknown')).toBe('text')
  expect(languageFor('LICENSE')).toBe('text')
})

test('the editor sits on the app surface in hex Monaco can parse', () => {
  const colors = editorThemeColors({ background: '#000', popover: '#121212', foreground: ' #f5f5f5', mutedForeground: '#848484', primary: '#4f5ff0' })
  expect(colors['editor.background']).toBe('#000000')
  expect(colors['editorGutter.background']).toBe('#000000')
  expect(colors['editorWidget.background']).toBe('#121212')
  expect(colors['editorCursor.foreground']).toBe('#f5f5f5')
  expect(colors.focusBorder).toBe('#4f5ff0')
})
