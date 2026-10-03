import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MainContext, MainPlugin } from '@treeix/sdk/main'
import { untilLabel } from '@treeix/app/time'
import { claudeStatusFile, setUpClaudeStatus } from './claudeStatus'
import { usageLimits, watchUsageSources } from './limits'
import { isMenuBarLabel, type AgentLimits, type LimitWindow, type MenuBarLabel } from '../shared/types'

// The folder from before plugins, so sessions started by an earlier version keep reporting here
const statusFolder = (): string => join(app.getPath('userData'), 'claude-status')
let bridge: Promise<() => Promise<Record<string, string>>> | null = null

// Windows reset on the clock, not on a write, so the menu bar re-reads now and then too
const MENU_BAR_POLL_MS = 60_000

const windowLabel = (name: string, window: LimitWindow | null): string => `${name} ${window ? `${window.usedPercent}% · ${untilLabel(window.resetsAt)}` : '-'}`
const share = (window: LimitWindow | null): number | null => (window ? window.usedPercent / 100 : null)
const percent = (window: LimitWindow | null): string => (window ? `${window.usedPercent}%` : '-')

// Kept by main, which draws the menu bar before any window has loaded the settings
const labelFile = (context: MainContext): string => join(context.dataPath, 'menu-bar.json')
function savedLabel(context: MainContext): MenuBarLabel {
  try {
    const saved: unknown = JSON.parse(readFileSync(labelFile(context), 'utf8'))
    return isMenuBarLabel(saved) ? saved : 'weekly'
  } catch {
    return 'weekly'
  }
}

async function showInMenuBar(context: MainContext, statusFile: string, label: MenuBarLabel): Promise<void> {
  const limits = await usageLimits(statusFile)
  const agents = (
    [
      ['Claude', limits.claude],
      ['Codex', limits.codex]
    ] satisfies [string, AgentLimits | null][]
  ).filter((entry): entry is [string, AgentLimits] => entry[1] !== null)
  const windowOf = (limits: AgentLimits): LimitWindow | null => (label === 'fiveHour' ? limits.fiveHour : limits.weekly)
  context.menuBar({
    title: label === 'weekly' || label === 'fiveHour' ? agents.map(([, limits]) => percent(windowOf(limits))).join(' ') : '',
    meters: label === 'rings' ? agents.map(([, { fiveHour, weekly }]) => [share(fiveHour), share(weekly)]) : [],
    lines: agents.map(([name, { fiveHour, weekly }]) => `${name}   ${windowLabel('5h', fiveHour)}   ${windowLabel('week', weekly)}`)
  })
}

const plugin: MainPlugin = {
  activate: (context) => {
    bridge = setUpClaudeStatus(statusFolder())
    const statusFile = claudeStatusFile(statusFolder())
    let label = savedLabel(context)
    const refresh = (): void => void showInMenuBar(context, statusFile, label).catch(() => undefined)
    context.on('menuBarLabel', (_, next: unknown) => {
      if (!isMenuBarLabel(next)) return
      label = next
      writeFileSync(labelFile(context), JSON.stringify(next))
      refresh()
    })
    context.handle('limits', () => usageLimits(statusFile))
    context.onDispose(
      watchUsageSources(statusFile, () => {
        context.broadcast('changed')
        refresh()
      })
    )
    refresh()
    const poll = setInterval(refresh, MENU_BAR_POLL_MS)
    context.onDispose(() => {
      clearInterval(poll)
      context.menuBar(null)
    })
    context.onDispose(() => (bridge = null))
  },
  // Claude sessions report their rate limits through the status line bridge
  sessionEnv: async () => (bridge ? (await bridge)() : {})
}

export default plugin
