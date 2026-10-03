import { BrowserWindow } from 'electron'
import type { MainPlugin } from '@treeix/sdk/main'
import type { SessionUsage, TerminalOptions, TranscriptRef } from '../shared/types'
import { sessionTools } from './agentTools'
import { codexConversations } from './codex'
import { claudeCost, watchStatuses, withStatusHooks } from './hooks'
import { mermaidDiagrams, readTranscript, searchTranscripts, transcriptUsage } from './transcripts'
import { createTerminal, reportStatus, killAllTerminals, killTerminal, listeningPorts, listTerminals, resizeTerminal, terminalCwd, writeTerminal } from './pty'

/** Stand-ins for when Treeix's MCP server couldn't start */
const NO_MCP = { TREEIX_CLAUDE_MCP: '{"mcpServers":{}}', TREEIX_CODEX_MCP: 'mcp_servers.treeix={url="http://127.0.0.1:9/mcp",enabled=false}' }

const plugin: MainPlugin = {
  tools: [
    {
      name: 'claude',
      purpose: 'Claude Code sessions',
      auth: false,
      releases: { url: 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest', field: 'version' },
      selfUpdate: 'claude update'
    },
    { name: 'codex', purpose: 'Codex sessions', auth: false, releases: { url: 'https://registry.npmjs.org/@openai/codex/latest', field: 'version' }, selfUpdate: 'codex update' }
  ],
  activate: (context) => {
    const statuses = watchStatuses(reportStatus)
    context.onDispose(() => void statuses.then(({ stop }) => stop()))
    // Built-in agent commands expand these, so each needs a harmless value when nothing else sets it
    context.handle('create', async (event, options: TerminalOptions) => {
      const env = { TREEIX_CLAUDE_SETTINGS: '{}', ...NO_MCP, ...(await context.sessionEnv(options.workspaceId)) }
      const { folder } = await statuses
      return createTerminal(event.sender, options, { ...env, TREEIX_CLAUDE_SETTINGS: withStatusHooks(env.TREEIX_CLAUDE_SETTINGS), TREEIX_AGENT_STATUS: folder })
    })
    // Keystrokes don't wait for an answer
    context.on('write', (_, id: string, data: string) => writeTerminal(id, data))
    context.on('resize', (_, id: string, cols: number, rows: number) => resizeTerminal(id, cols, rows))
    context.on('kill', (_, id: string) => killTerminal(id))
    context.handle('list', (event) => listTerminals(event.sender))
    context.handle('cwd', (_, id: string) => terminalCwd(id))
    context.handle('ports', () => listeningPorts())
    context.handle('codexConversations', (_, cwd: string, since: number) => codexConversations(cwd, since))
    context.handle('searchTranscripts', (_, query: string, refs: TranscriptRef[]) => searchTranscripts(String(query), Array.isArray(refs) ? refs : []))
    context.handle('usage', async (_, ref: TranscriptRef): Promise<SessionUsage | null> => {
      const [usage, costUsd] = await Promise.all([transcriptUsage(ref), statuses.then(({ folder }) => claudeCost(folder, ref.sessionId))])
      return usage && { ...usage, costUsd }
    })
    context.handle('diagrams', async (_, ref: TranscriptRef) => mermaidDiagrams(ref.kind, await readTranscript(ref)))
    // ponytail: the focused window, else any; one per session's own window if people run agents across several windows
    const window = (): Electron.WebContents | null =>
      (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((candidate) => candidate.isVisible()) ?? BrowserWindow.getAllWindows()[0])?.webContents ?? null
    sessionTools(context, window).forEach(context.mcpTool)
    context.onDispose(killAllTerminals)
  }
}

export default plugin
