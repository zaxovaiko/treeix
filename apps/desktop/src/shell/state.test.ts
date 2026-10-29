import { expect, test } from 'bun:test'
import type { Place, SessionInfo } from '../ipc/api'
import { groupTabs, initialUi, leaves, neighbor, parseUi, reducer, restore, tabPlace, zoomed, type UiState } from './state'

const info = (id: string, createdAt = 0): SessionInfo => ({
  id,
  kind: 'shell',
  cwd: '/',
  title: id,
  status: 'idle',
  pid: 1,
  exitCode: null,
  cols: 80,
  rows: 24,
  createdAt,
  command: [],
  seq: 0,
  agentSession: null,
  routine: null,
})

const open = (state: UiState, session: string) => reducer(state, { type: 'open', session, tabId: `t-${session}` })

test('splits the focused pane and closing the last pane closes the tab', () => {
  let s = open(initialUi, 'a')
  s = reducer(s, { type: 'split', session: 'b', dir: 'row' })
  s = reducer(s, { type: 'split', session: 'c', dir: 'col' })
  expect(leaves(s.tabs[0].root)).toEqual(['a', 'b', 'c'])
  expect(s.tabs[0].focus).toBe('c')
  s = reducer(s, { type: 'remove', session: 'c' })
  expect(s.tabs[0].focus).toBe('a')
  s = reducer(reducer(s, { type: 'remove', session: 'a' }), { type: 'remove', session: 'b' })
  expect(s.tabs).toEqual([])
  expect(s.active).toBeNull()
})

test('closing the active tab activates its neighbour', () => {
  let s = open(open(open(initialUi, 'a'), 'b'), 'c')
  s = reducer(s, { type: 'activate', tabId: 't-b' })
  s = reducer(s, { type: 'remove', session: 'b' })
  expect(s.active).toBe('t-c')
})

test('restore drops gone sessions and gives orphans a tab', () => {
  let saved = open(initialUi, 'a')
  saved = reducer(saved, { type: 'split', session: 'gone', dir: 'row' })
  const s = restore(saved, [info('a'), info('new', 5)])
  expect(s.tabs.map((t) => leaves(t.root))).toEqual([['a'], ['new']])
  expect(s.tabs[0].root.type).toBe('pane')
  expect(s.active).toBe('t-a')
})

test('parseUi falls back on garbage and keeps unknown versions safe', () => {
  expect(parseUi('nope')).toBe(initialUi)
  expect(parseUi('{"theme":"light"}').theme).toBe('light')
})

test('a single pane follows its cwd, a split keeps its place', () => {
  const place = (key: string): Place => ({ key, kind: 'folder', name: key, path: key, repoRoot: null, repoName: null, branch: null, head: null, missing: false })
  const where: Record<string, Place> = { a: place('/x'), b: place('/y') }
  let s = open(initialUi, 'a')
  expect(tabPlace(s.tabs[0], (id) => where[id])).toBe('/x')
  s = reducer(s, { type: 'split', session: 'b', dir: 'row', place: '/x' })
  where.a = place('/z')
  expect(tabPlace(s.tabs[0], (id) => where[id])).toBe('/x')
})

test('focus moves to the pane beside, by overlap', () => {
  let s = open(initialUi, 'a')
  s = reducer(s, { type: 'split', session: 'b', dir: 'row' })
  s = reducer(s, { type: 'split', session: 'c', dir: 'col' })
  const root = s.tabs[0].root
  expect(neighbor(root, 'a', 'right')).toBe('b')
  expect(neighbor(root, 'b', 'down')).toBe('c')
  expect(neighbor(root, 'c', 'left')).toBe('a')
  expect(neighbor(root, 'a', 'left')).toBeNull()
})

test('tabs group by repo, then place, in the saved order', () => {
  const place = (key: string, kind: Place['kind'], repoRoot: string | null, name = key): Place => ({ key, kind, name, path: key, repoRoot, repoName: repoRoot, branch: null, head: null, missing: false })
  const where: Record<string, Place> = {
    a: place('/r/.worktrees/x', 'worktree', '/r', 'x'),
    b: place('/r', 'root', '/r', 'main'),
    c: place('/dl', 'folder', null),
    d: place('/r', 'root', '/r', 'main'),
  }
  let s = initialUi
  for (const id of ['a', 'b', 'c', 'd']) s = open(s, id)
  const groups = groupTabs(s.tabs, (t) => where[t.focus], ['/dl'])
  expect(groups.map((g) => g.key)).toEqual(['/dl', '/r'])
  expect(groups[1].places.map((p) => [p.place.name, p.tabs.length])).toEqual([
    ['main', 2],
    ['x', 1],
  ])
})

test('older blobs get the settings defaults, and settings patch in', () => {
  const old = parseUi(JSON.stringify({ theme: 'light' }))
  expect(old.renderer).toBe('auto')
  expect(old.quickShortcut).toBeNull()
  const s = reducer(old, { type: 'set', patch: { renderer: 'dom', quickShortcut: 'Control+Backquote' } })
  expect([s.renderer, s.quickShortcut, s.theme]).toEqual(['dom', 'Control+Backquote', 'light'])
})

test('a background open adds the tab and keeps the active one', () => {
  const s = restore(initialUi, [info('a')])
  const next = reducer(s, { type: 'open', session: 'b', tabId: 'tb', background: true })
  expect(next.tabs.map((t) => t.id)).toContain('tb')
  expect(next.active).toBe(s.active)
})

test('zoom steps by 10% and stays between 50% and 200%', () => {
  expect(zoomed(1, 1)).toBe(1.1)
  expect(zoomed(0.7, -1)).toBe(0.6)
  expect(zoomed(2, 1)).toBe(2)
  expect(zoomed(0.5, -1)).toBe(0.5)
})

test('a group color is picked per place and resets to the default', () => {
  const picked = reducer(initialUi, { type: 'color', key: '/repo', color: '#f43f5e' })
  expect(picked.colors).toEqual({ '/repo': '#f43f5e' })
  expect(reducer(picked, { type: 'color', key: '/repo', color: null }).colors).toEqual({})
})
