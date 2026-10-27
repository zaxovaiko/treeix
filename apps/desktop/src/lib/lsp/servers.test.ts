import { describe, expect, test } from 'bun:test'
import { languageId, parseConfig, serversFor, withConfig } from './servers'

describe('language servers', () => {
  test('a repo config adds servers and replaces the app one of the same name', () => {
    const custom = parseConfig('{"lua":{"command":["lua-language-server"],"files":["*.lua"]},"TypeScript":{"command":["vtsls","--stdio"],"files":["*.ts"]},"bad":{"command":"x"}}')
    expect(custom.map((s) => s.name)).toEqual(['lua', 'TypeScript'])
    const specs = withConfig(custom)
    expect(serversFor('/r/a.lua', specs).map((s) => s.command[0])).toEqual(['lua-language-server'])
    expect(serversFor('/r/a.ts', specs).map((s) => s.command[0])).toEqual(['vtsls'])
    expect(serversFor('/r/a.tsx', specs)).toEqual([])
  })

  test('broken config is no servers', () => {
    expect(parseConfig('{')).toEqual([])
    expect(parseConfig('[1]')).toEqual([])
  })

  test('React files get their own LSP ids', () => {
    expect(languageId('/r/App.tsx')).toBe('typescriptreact')
    expect(languageId('/r/main.rs')).toBe('rust')
  })
})
