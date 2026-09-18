import type { MainPlugin } from '@treeix/sdk/main'
import type { TerminalOptions } from '../shared/types'
import { createTerminal, killAllTerminals, killTerminal, listTerminals, resizeTerminal, terminalCwd, writeTerminal } from './pty'

const plugin: MainPlugin = {
  tools: [
    { name: 'claude', purpose: 'Claude Code sessions', auth: false, releases: { url: 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest', field: 'version' }, selfUpdate: 'claude update' },
    { name: 'codex', purpose: 'Codex sessions', auth: false, releases: { url: 'https://registry.npmjs.org/@openai/codex/latest', field: 'version' }, selfUpdate: 'codex update' }
  ],
  activate: (context) => {
    // Claude sessions start with `claude --settings "$TREEIX_CLAUDE_SETTINGS"`, which needs a value even when no plugin adds settings
    context.handle('create', async (event, options: TerminalOptions) =>
      createTerminal(event.sender, options, { TREEIX_CLAUDE_SETTINGS: '{}', ...(await context.sessionEnv()) })
    )
    // Keystrokes don't wait for an answer
    context.on('write', (_, id: string, data: string) => writeTerminal(id, data))
    context.on('resize', (_, id: string, cols: number, rows: number) => resizeTerminal(id, cols, rows))
    context.on('kill', (_, id: string) => killTerminal(id))
    context.handle('list', (event) => listTerminals(event.sender))
    context.handle('cwd', (_, id: string) => terminalCwd(id))
    context.onDispose(killAllTerminals)
  }
}

export default plugin
