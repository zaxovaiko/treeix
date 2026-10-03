import { expect, test } from 'bun:test'
import { type AxNode, formatSnapshot, parseKey } from './snapshot'

const node = (nodeId: string, role: string, name: string, childIds: string[] = [], extra: Partial<AxNode> = {}): AxNode => ({
  nodeId,
  role: { value: role },
  name: { value: name },
  childIds,
  backendDOMNodeId: Number(nodeId) + 100,
  ...extra
})

test('formatSnapshot lifts wrappers, drops text repeating its parent and gives refs', () => {
  const nodes = [
    node('1', 'RootWebArea', 'Shop', ['2', '6']),
    node('2', 'generic', '', ['3', '5']),
    node('3', 'link', 'Home', ['4']),
    node('4', 'StaticText', 'Home'),
    node('5', 'textbox', 'Email', [], { value: { value: 'a@b.c' }, properties: [{ name: 'focused', value: { value: true } }] }),
    node('6', 'heading', 'Cart', [], { properties: [{ name: 'level', value: { value: 2 } }] }),
    node('7', 'button', 'Hidden', [], { ignored: true })
  ]
  expect(formatSnapshot(nodes)).toBe(
    ['- RootWebArea "Shop" [ref=101]', '  - link "Home" [ref=103]', '  - textbox "Email" value="a@b.c" focused [ref=105]', '  - heading "Cart" level=2 [ref=106]'].join('\n')
  )
})

test('parseKey knows named keys, characters and modifiers', () => {
  expect(parseKey('Enter')).toEqual({ key: 'Enter', code: 'Enter', keyCode: 13, text: '\r', modifiers: 0 })
  expect(parseKey('Meta+a')).toEqual({ key: 'a', code: 'KeyA', keyCode: 65, text: undefined, modifiers: 4 })
  expect(parseKey('Shift+Tab')).toMatchObject({ code: 'Tab', modifiers: 8 })
  expect(parseKey('Hyper+x')).toBeNull()
  expect(parseKey('F13')).toBeNull()
})
