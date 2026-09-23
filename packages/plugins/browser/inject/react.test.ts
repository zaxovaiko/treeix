import { expect, test } from 'bun:test'
import { reactOf } from './react'

// Sent to the page as text, so it is run here the same way: anything it used from outside itself would throw
const inPage = new Function('element', `return (${reactOf})(element)`) as typeof reactOf

function Card(): null {
  return null
}
const Avatar = Object.assign(() => null, { displayName: 'Avatar' })

test('reads the components and the React 19 stack frame where the element is written', () => {
  const card = { type: Card, return: null }
  const memo = { type: { type: Avatar }, return: card }
  const avatar = { type: Avatar, return: memo }
  const stack = ['Error: react-stack-top-frame', '    at jsxDEV (http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1:250:12)', '    at Avatar (http://localhost:5173/src/components/Avatar.tsx?t=17:42:7)'].join('\n')
  const img = { type: 'img', return: avatar, _debugStack: { stack } }
  expect(inPage({ __reactFiber$x1: img } as unknown as Element)).toEqual({
    components: ['Card', 'Avatar'],
    source: 'src/components/Avatar.tsx:42',
    frame: { url: 'http://localhost:5173/src/components/Avatar.tsx?t=17', line: 42, column: 7 }
  })
})

test('prefers React 18 debug source and gives null for a page without React', () => {
  const span = { type: 'span', return: { type: Card, return: null }, _debugSource: { fileName: '/app/src/Card.tsx', lineNumber: 9 } }
  expect(inPage({ __reactFiber$y: span } as unknown as Element)).toEqual({ components: ['Card'], source: '/app/src/Card.tsx:9' })
  expect(inPage({} as Element)).toBeNull()
})
