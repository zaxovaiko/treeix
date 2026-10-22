import { expect, test } from 'bun:test'
import { DEFAULT_SETTINGS } from '../../features'
import { fontStack, themeVars } from './apply'
import { onSettingsSection, openableSection, showSettingsSection, takeRequestedSection } from './nav'

test('fontStack quotes family names but not CSS font keywords', () => {
  expect(fontStack('', 'monospace')).toBe('monospace')
  expect(fontStack(' Geist "Mono" ', 'monospace')).toBe('"Geist Mono", monospace')
  expect(fontStack('ui-monospace', 'monospace')).toBe('ui-monospace, monospace')
})

test('a theme falls back to the stylesheet default of its mode', () => {
  expect(themeVars('dark', 'Neutral')).toEqual({})
  expect(themeVars('dark', 'gone')).toEqual({})
  // A light-only name picked for the dark slot
  expect(themeVars('dark', 'Light')).toEqual({})
  const nord = themeVars('dark', 'Nord')
  expect(nord['--background']).toBe('#2e3440')
  expect(nord['--primary']).toBe('#88c0d0')
  expect(nord['--popover']).toBe('color-mix(in srgb, var(--foreground) 7%, #2e3440)')
  expect(themeVars('light', 'Claude')['--popover']).toBe('color-mix(in srgb, var(--foreground) 0%, #faf9f5)')
})

test('a remembered section falls back to Features once its feature is off', () => {
  const features = { ...DEFAULT_SETTINGS.features, notion: true }
  expect(openableSection('notion', features)).toBe('notion')
  expect(openableSection('notion', { ...features, notion: false })).toBe('features')
  expect(openableSection('appearance', { ...features, notion: false })).toBe('appearance')
})

test('showSettingsSection waits for a closed page and goes straight to an open one', () => {
  showSettingsSection('usage')
  expect(takeRequestedSection()).toBe('usage')
  expect(takeRequestedSection()).toBeNull()
  const seen: string[] = []
  const stop = onSettingsSection((section) => seen.push(section))
  showSettingsSection('terminal')
  stop()
  expect(seen).toEqual(['terminal'])
  expect(takeRequestedSection()).toBeNull()
})
