import { expect, test } from 'bun:test'

test('clampOpacity keeps the window visible', async () => {
  globalThis.localStorage ??= { getItem: () => null, setItem: () => undefined } as unknown as Storage
  const { clampOpacity } = await import('./settings')
  expect(clampOpacity(10)).toBe(40)
  expect(clampOpacity(72.4)).toBe(72)
  expect(clampOpacity(250)).toBe(100)
  expect(clampOpacity('80')).toBe(100)
  const { withAlpha } = await import('./themes')
  expect(withAlpha('#0a0b0c', 0.7)).toBe('rgb(10 11 12 / 70%)')
  expect(withAlpha('#0a0b0c', 1)).toBe('#0a0b0c')
})

test('digitPressed matches the physical digit with exactly the chosen modifiers', async () => {
  const { digitPressed } = await import('./settings')
  const key = (code: string, modifiers: Partial<Pick<KeyboardEvent, 'metaKey' | 'altKey' | 'ctrlKey' | 'shiftKey'>> = {}) =>
    ({ code, metaKey: false, altKey: false, ctrlKey: false, shiftKey: false, ...modifiers }) as KeyboardEvent
  expect(digitPressed(key('Digit3', { metaKey: true }), 'meta')).toBe(3)
  expect(digitPressed(key('Digit3', { metaKey: true, altKey: true }), 'meta')).toBeNull()
  expect(digitPressed(key('Digit0', { metaKey: true, altKey: true }), 'altMeta')).toBe(0)
  expect(digitPressed(key('Digit2', { altKey: true }), 'alt')).toBe(2)
  expect(digitPressed(key('KeyA', { altKey: true }), 'alt')).toBeNull()
  expect(digitPressed(key('Digit2', { altKey: true }), 'off')).toBeNull()
})

test('fontStack quotes family names but not system font keywords', async () => {
  const { fontStack } = await import('./settings')
  expect(fontStack('', 'serif')).toBe('serif')
  expect(fontStack(' Geist "Mono" ', 'monospace')).toBe('"Geist Mono", monospace')
  expect(fontStack('ui-monospace', 'monospace')).toBe('ui-monospace, monospace')
})

test('parseCustomAgents keeps chat only when adapter and command are both strings', async () => {
  const { parseCustomAgents } = await import('./settings')
  const base = { id: 'aider', label: 'Aider', mark: 'A', color: '#fff', command: 'aider', agent: true }
  expect(parseCustomAgents([base])[0]?.chat).toBeUndefined()
  expect(parseCustomAgents([{ ...base, chat: { adapter: 'acp', command: 'aider --acp' } }])[0]?.chat).toEqual({ adapter: 'acp', command: 'aider --acp' })
  expect(parseCustomAgents([{ ...base, chat: 'acp' }])[0]?.chat).toBeUndefined()
  expect(parseCustomAgents([{ ...base, chat: { adapter: 'acp' } }])[0]?.chat).toBeUndefined()
  expect(parseCustomAgents([{ ...base, chat: { command: 'aider --acp' } }])[0]?.chat).toBeUndefined()
})

test('parseAgentViews drops garbage and keeps only chat/terminal values', async () => {
  const { parseAgentViews } = await import('./settings')
  expect(parseAgentViews(null)).toEqual({})
  expect(parseAgentViews('nonsense')).toEqual({})
  expect(parseAgentViews({ claude: 'chat', codex: 'terminal', shell: 'loud', gemini: 3 })).toEqual({ claude: 'chat', codex: 'terminal' })
})

test('parseChatThinking falls back to collapsed for unknown values and keeps expanded/hidden', async () => {
  const { parseChatThinking } = await import('./settings')
  expect(parseChatThinking(undefined)).toBe('collapsed')
  expect(parseChatThinking('loud')).toBe('collapsed')
  expect(parseChatThinking('expanded')).toBe('expanded')
  expect(parseChatThinking('hidden')).toBe('hidden')
})
