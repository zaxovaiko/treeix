import { useEffect, useState } from 'react'
import type { AgentLimits, LimitWindow, UsageLimits as Limits } from '../shared/types'
import { untilLabel } from '@treeix/app/time'
import { KindBadge } from '@treeix/app/sessionUi'
import { createBridge, definePluginSettings, useHost } from '@treeix/sdk'

const USAGE_LABEL_IDS = ['reset', 'percent', 'remaining', 'weekly', 'bars', 'hidden'] as const
export type UsageLabel = (typeof USAGE_LABEL_IDS)[number]

export const usageSettings = definePluginSettings('usage-limits', (stored) => ({
  /** Title bar label for Claude and Codex usage limits */
  usageLabel: USAGE_LABEL_IDS.find((id) => id === stored.usageLabel) ?? ('reset' as UsageLabel)
}))

const bridge = createBridge('usage-limits')

export const USAGE_LABELS: [UsageLabel, string, string][] = [
  ['reset', 'Percent and reset', '5h 35% · 2h   wk 28% · 5d'],
  ['percent', 'Percent', '35% · 28%'],
  ['remaining', 'Remaining', '65% · 72% left'],
  ['weekly', 'Weekly and reset', '28% in 5d'],
  ['bars', 'Bars', '▰▰▱ ▰▱▱'],
  ['hidden', 'Hidden', '']
]

// Changes are pushed as sources are written; the poll only ages out windows that reset
const POLL_MS = 60_000

const levelColor = (percent: number): string => (percent >= 90 ? 'text-red-400' : percent >= 70 ? 'text-amber-400' : 'text-foreground/80')

function Bar({ window }: { window: LimitWindow | null }): React.JSX.Element {
  const percent = window?.usedPercent ?? 0
  const fill = percent >= 90 ? 'bg-red-400' : percent >= 70 ? 'bg-amber-400' : 'bg-foreground/60'
  return (
    <span className="h-1.5 w-8 overflow-hidden rounded-full bg-foreground/10">
      <span style={{ width: `${percent}%` }} className={`block h-full rounded-full ${fill}`} />
    </span>
  )
}

function Percent({ window, remaining = false }: { window: LimitWindow | null; remaining?: boolean }): React.JSX.Element {
  if (!window) return <span className="text-muted-foreground">-</span>
  return <span className={`tabular-nums ${levelColor(window.usedPercent)}`}>{remaining ? 100 - window.usedPercent : window.usedPercent}%</span>
}

function AgentLabel({ limits, label }: { limits: AgentLimits; label: UsageLabel }): React.JSX.Element {
  const { fiveHour, weekly } = limits
  const muted = 'text-muted-foreground'
  if (label === 'bars') {
    return (
      <>
        <Bar window={fiveHour} />
        <Bar window={weekly} />
      </>
    )
  }
  if (label === 'weekly') {
    return (
      <>
        <Percent window={weekly} /> <span className={muted}>in {untilLabel(weekly?.resetsAt ?? null)}</span>
      </>
    )
  }
  if (label === 'reset') {
    return (
      <>
        <span className={muted}>5h</span> <Percent window={fiveHour} /> <span className={muted}>· {untilLabel(fiveHour?.resetsAt ?? null)}</span>
        <span className={`ml-1.5 ${muted}`}>wk</span> <Percent window={weekly} /> <span className={muted}>· {untilLabel(weekly?.resetsAt ?? null)}</span>
      </>
    )
  }
  const remaining = label === 'remaining'
  return (
    <>
      <Percent window={fiveHour} remaining={remaining} /> <span className={muted}>·</span> <Percent window={weekly} remaining={remaining} />
      {remaining && <span className={muted}>left</span>}
    </>
  )
}

function describe(name: string, limits: AgentLimits): string {
  const line = (title: string, window: LimitWindow | null): string =>
    window
      ? `${name} ${title}: ${window.usedPercent}% used${window.resetsAt ? `, resets in ${untilLabel(window.resetsAt)} (${new Date(window.resetsAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })})` : ''}`
      : `${name} ${title}: unknown`
  const updated = limits.updatedAt ? `Updated ${untilLabel(Date.now() + (Date.now() - limits.updatedAt))} ago` : ''
  return [line('5-hour', limits.fiveHour), line('weekly', limits.weekly), updated].filter(Boolean).join('\n')
}

/** Claude and Codex subscription windows for the title bar */
export function UsageLimits(): React.JSX.Element | null {
  const { openSettings: onOpenSettings } = useHost()
  const { usageLabel } = usageSettings.use()
  const [limits, setLimits] = useState<Limits | null>(null)

  useEffect(() => {
    if (usageLabel === 'hidden') return
    // Same readings keep the old object, so the title bar doesn't re-render
    const load = (): void => void bridge.invoke<Limits>('limits').then((next) => setLimits((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next)))
    load()
    const timer = setInterval(load, POLL_MS)
    window.addEventListener('focus', load)
    const unsubscribe = bridge.on('changed', load)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', load)
      unsubscribe()
    }
  }, [usageLabel])

  if (usageLabel === 'hidden' || !limits) return null
  const agents = (
    [
      ['claude', 'Claude', limits.claude],
      ['codex', 'Codex', limits.codex]
    ] as const
  ).flatMap(([kind, name, agentLimits]) => (agentLimits ? [[kind, name, agentLimits] as const] : []))
  if (agents.length === 0) return null

  return (
    <button
      onClick={onOpenSettings}
      title={`${agents.map(([, name, agentLimits]) => describe(name, agentLimits)).join('\n\n')}\n\nClick to change this label`}
      className="flex h-6 shrink-0 items-center gap-3 rounded-md px-2 text-[11.5px] hover:bg-accent [-webkit-app-region:no-drag]"
    >
      {agents.map(([kind, , agentLimits]) => (
        <span key={kind} className="flex items-center gap-1.5 whitespace-nowrap">
          <KindBadge kind={kind} />
          <AgentLabel limits={agentLimits} label={usageLabel} />
        </span>
      ))}
    </button>
  )
}
