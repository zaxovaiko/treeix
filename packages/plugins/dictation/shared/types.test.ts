import { expect, test } from 'bun:test'
import { DEFAULT_HOTKEY, parseSettings } from './types'

test('the hotkey is a chord of known modifiers, the old single key carries over', () => {
  expect(parseSettings({ hotkey: ['MetaLeft', 'AltRight'] }).hotkey).toEqual(['MetaLeft', 'AltRight'])
  expect(parseSettings({ hotkey: ['MetaLeft', 'KeyA'] }).hotkey).toEqual(['MetaLeft'])
  expect(parseSettings({ hotkey: 'rightCommand' }).hotkey).toEqual(['MetaRight'])
  expect(parseSettings({ hotkey: 'toString' }).hotkey).toEqual(DEFAULT_HOTKEY)
  expect(parseSettings({}).hotkey).toEqual(DEFAULT_HOTKEY)
})
