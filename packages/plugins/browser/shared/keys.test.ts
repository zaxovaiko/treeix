import { expect, test } from 'bun:test'
import { browserAction, forwardsToApp, type KeyInput } from './keys'

const key = (code: string, mods: Partial<KeyInput> = {}): KeyInput => ({ code, meta: true, shift: false, alt: false, control: false, ...mods })

test('browserAction maps Chrome keys', () => {
  expect(browserAction(key('KeyL'))).toBe('focusAddress')
  expect(browserAction(key('KeyT'))).toBe('newTab')
  expect(browserAction(key('KeyT', { shift: true }))).toBe('reopenTab')
  expect(browserAction(key('KeyW'))).toBe('closeTab')
  expect(browserAction(key('BracketLeft'))).toBe('back')
  expect(browserAction(key('KeyI', { alt: true }))).toBe('devtools')
  expect(browserAction(key('KeyC', { shift: true }))).toBe('designMode')
  expect(browserAction(key('KeyL', { meta: false }))).toBeNull()
  expect(browserAction(key('KeyL', { control: true }))).toBeNull()
})

test('forwardsToApp keeps editing keys in the page and sends the rest to the app', () => {
  expect(forwardsToApp(key('KeyC'))).toBe(false)
  expect(forwardsToApp(key('KeyZ', { shift: true }))).toBe(false)
  expect(forwardsToApp(key('KeyF'))).toBe(false)
  expect(forwardsToApp(key('KeyK'))).toBe(true)
  expect(forwardsToApp(key('KeyJ'))).toBe(true)
  expect(forwardsToApp(key('KeyL'))).toBe(false)
  expect(forwardsToApp(key('KeyK', { meta: false }))).toBe(false)
})

test('forwardsToApp leaves native menu keys alone, so the menu still gets them', () => {
  for (const code of ['KeyQ', 'KeyH', 'KeyM', 'Equal', 'Minus', 'Digit0']) expect(forwardsToApp(key(code))).toBe(false)
  expect(forwardsToApp(key('KeyH', { alt: true }))).toBe(false)
  expect(forwardsToApp(key('Equal', { shift: true }))).toBe(false)
  expect(forwardsToApp(key('KeyR', { shift: true }))).toBe(false)
  expect(forwardsToApp(key('KeyF', { control: true }))).toBe(false)
})
