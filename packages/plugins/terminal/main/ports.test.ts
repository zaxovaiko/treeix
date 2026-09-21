import { expect, test } from 'bun:test'
import { attributePorts, parseListeners, parseParents } from './ports'

const PS = `    1     0
  500     1
  501   500
  502   501
  600     1
  700   600
  900     1
`

const LSOF = `p502
f12
n*:5173
f13
n[::1]:5173
p700
f20
n127.0.0.1:3000
f21
n[::1]:8080
p900
f5
n*:7000
`

test('reads pid and parent pairs from ps', () => {
  const parents = parseParents(PS)
  expect(parents.get(502)).toBe(501)
  expect(parents.get(1)).toBe(0)
  expect(parents.size).toBe(7)
})

test('reads listening ports per pid from lsof, whatever the address form', () => {
  expect(parseListeners(LSOF)).toEqual([
    { pid: 502, port: 5173 },
    { pid: 502, port: 5173 },
    { pid: 700, port: 3000 },
    { pid: 700, port: 8080 },
    { pid: 900, port: 7000 }
  ])
})

test('ignores lines it does not know and names without a port', () => {
  expect(parseListeners('garbage\np12\nnlocalhost\nn*:abc\n\n')).toEqual([])
})

test('gives a port to the session whose shell is an ancestor or the process itself, once per session', () => {
  const shells = new Map([
    ['a', 500],
    ['b', 700]
  ])
  expect(attributePorts(shells, parseParents(PS), parseListeners(LSOF))).toEqual([
    { sessionId: 'a', port: 5173 },
    { sessionId: 'b', port: 3000 },
    { sessionId: 'b', port: 8080 }
  ])
})

test('drops ports outside every session and survives a parent cycle', () => {
  const parents = new Map([
    [10, 11],
    [11, 10]
  ])
  expect(attributePorts(new Map([['a', 500]]), parents, [{ pid: 10, port: 80 }])).toEqual([])
})
