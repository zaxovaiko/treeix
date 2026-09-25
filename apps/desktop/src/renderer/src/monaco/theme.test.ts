import { expect, test } from 'bun:test'
import { THEMES } from '../themes'
import { editorThemeColors, languageFor } from './theme'

test('maps paths to shiki languages, plain text when unknown', () => {
  expect(languageFor('src/App.tsx')).toBe('tsx')
  expect(languageFor('a/b.mts')).toBe('typescript')
  expect(languageFor('README.md')).toBe('markdown')
  expect(languageFor('Dockerfile')).toBe('docker')
  expect(languageFor('notes.unknownext')).toBe('text')
})

test('a translucent window makes the editor see-through', () => {
  expect(editorThemeColors(THEMES.neutral, 100)['editor.background']).toBe('#000000')
  expect(editorThemeColors(THEMES.neutral, 90)['editor.background']).toBe('#00000000')
  expect(editorThemeColors(THEMES.neutral, 90)['editorGutter.background']).toBe('#00000000')
})
