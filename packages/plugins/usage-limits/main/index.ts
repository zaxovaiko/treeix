import { app } from 'electron'
import { join } from 'node:path'
import type { MainPlugin } from '@treeix/sdk/main'
import { claudeStatusFile, setUpClaudeStatus } from './claudeStatus'
import { usageLimits, watchUsageSources } from './limits'

// The folder from before plugins, so sessions started by an earlier version keep reporting here
const statusFolder = (): string => join(app.getPath('userData'), 'claude-status')
let bridge: Promise<() => Promise<Record<string, string>>> | null = null

const plugin: MainPlugin = {
  activate: (context) => {
    bridge = setUpClaudeStatus(statusFolder())
    const statusFile = claudeStatusFile(statusFolder())
    context.handle('limits', () => usageLimits(statusFile))
    context.onDispose(watchUsageSources(statusFile, () => context.broadcast('changed')))
    context.onDispose(() => (bridge = null))
  },
  // Claude sessions report their rate limits through the status line bridge
  sessionEnv: async () => (bridge ? (await bridge)() : {})
}

export default plugin
