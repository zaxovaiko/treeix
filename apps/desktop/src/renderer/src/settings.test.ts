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

test('parseAppearance moves the old single theme into its mode', async () => {
  const { parseAppearance } = await import('./settings')
  expect(parseAppearance({ theme: 'nord' })).toEqual({ themeMode: 'dark', lightTheme: 'light', darkTheme: 'nord' })
  expect(parseAppearance({ theme: 'light' })).toEqual({ themeMode: 'light', lightTheme: 'light', darkTheme: 'neutral' })
  expect(parseAppearance({ theme: 'system' })).toEqual({ themeMode: 'system', lightTheme: 'light', darkTheme: 'neutral' })
  expect(parseAppearance({ themeMode: 'system', lightTheme: 'github-light', darkTheme: 'github-dark', theme: 'nord' })).toEqual({ themeMode: 'system', lightTheme: 'github-light', darkTheme: 'github-dark' })
  expect(parseAppearance({})).toEqual({ themeMode: 'dark', lightTheme: 'light', darkTheme: 'neutral' })
})

test('resolveTheme falls back to the built-in theme of the mode', async () => {
  const { resolveTheme, setPluginThemes, THEMES } = await import('./themes')
  const pack = { 'github-light': { ...THEMES.light, label: 'GitHub', primary: '#0969da' } }
  expect(resolveTheme('github-light', 'light')).toBe(THEMES.light)
  setPluginThemes(pack)
  expect(resolveTheme('github-light', 'light')).toBe(pack['github-light'])
  // A light theme picked for the dark slot, or an unknown id, gets the mode's default
  expect(resolveTheme('github-light', 'dark')).toBe(THEMES.neutral)
  expect(resolveTheme('gone', 'light')).toBe(THEMES.light)
  setPluginThemes({})
})

test('parseThemeFile reads VS Code color themes with comments and the app theme shape', async () => {
  const { parseThemeFile } = await import('./themes')
  const vscode = parseThemeFile(`{
    // exported from VS Code
    "$schema": "vscode://schemas/color-theme",
    "name": "Paper", "type": "light",
    "colors": { "editor.background": "#fafafa", "editor.foreground": "#222", "button.background": "#0066ccff", },
    "tokenColors": [{ "scope": "comment", "settings": { "foreground": "#888888" } }],
  }`)
  expect(vscode).toMatchObject({ label: 'Paper', mode: 'light', background: '#fafafa', card: '#fafafa', foreground: '#222222', primary: '#0066cc' })
  expect(vscode?.syntax).toMatchObject({ tokenColors: [{ scope: 'comment' }] })
  const own = { label: 'Mine', mode: 'dark', background: '#000000', card: '#111111', popover: '#222222', foreground: '#ffffff', mutedForeground: '#888888', primary: '#ff0000', syntax: 'nord' }
  expect(parseThemeFile(JSON.stringify(own))).toMatchObject(own)
  expect(parseThemeFile('{"colors": {}}')).toBeNull()
  expect(parseThemeFile('not json')).toBeNull()
})

test('terminalPalette takes the code theme ANSI colors, Pierre filling the gaps', async () => {
  const { terminalPalette, THEMES } = await import('./themes')
  expect(await terminalPalette({ ...THEMES.neutral, syntax: 'dracula' })).toMatchObject({ red: '#FF5555', brightGreen: '#69FF94' })
  // light-plus has no terminal colors
  expect(Object.keys(await terminalPalette({ ...THEMES.light, syntax: 'light-plus' }))).toHaveLength(16)
})
