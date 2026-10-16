import { Fragment, useEffect, useMemo, useState } from 'react'
import { createBridge } from '@treeix/sdk'
import { errorMessage } from '@treeix/shared/errors'
import { Card, useSettingMatch } from '@treeix/app/settingsUi'
import type { AgentUsage as Usage, UsageRow } from '../shared/types'

const bridge = createBridge('agent-usage')

const RANGES = [
  ['today', 'Today'],
  ['week', 'Last 7 days'],
  ['month', 'This month'],
  ['30days', 'Last 30 days'],
  ['all', 'All time']
] as const
type Range = (typeof RANGES)[number][0]

const AGENT_NAMES: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  ollama: 'Ollama'
}
const agentName = (id: string): string => AGENT_NAMES[id] ?? id

const compact = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumSignificantDigits: 3
}).format
const usd = (amount: number): string => (amount >= 100 ? `$${Math.round(amount).toLocaleString('en')}` : `$${amount.toFixed(2)}`)

const dayOf = (date: Date): string => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
const daysAgo = (days: number): string => {
  const date = new Date()
  date.setDate(date.getDate() - days)
  return dayOf(date)
}

function rangeStart(range: Range, rows: UsageRow[]): string {
  if (range === 'today') return daysAgo(0)
  if (range === 'week') return daysAgo(6)
  if (range === '30days') return daysAgo(29)
  if (range === 'month') return `${daysAgo(0).slice(0, 8)}01`
  return rows.reduce((first, row) => (row.day < first ? row.day : first), daysAgo(0))
}

function daysFrom(start: string): string[] {
  const days: string[] = []
  const date = new Date(`${start}T00:00:00`)
  for (const today = daysAgo(0); dayOf(date) <= today; date.setDate(date.getDate() + 1)) days.push(dayOf(date))
  return days
}

const tokensOf = (row: UsageRow): number => row.input + row.output + row.cacheRead + row.cacheWrite

type Group = { name: string; tokens: number; cost: number | null }

/** Tokens and cost per name, most tokens first; cost stays null when none of the name's models has a price */
function groupBy(rows: UsageRow[], nameOf: (row: UsageRow) => string, costOf: (row: UsageRow) => number | null): Group[] {
  const groups = new Map<string, Group>()
  for (const row of rows) {
    const group = groups.get(nameOf(row)) ?? {
      name: nameOf(row),
      tokens: 0,
      cost: null
    }
    const cost = costOf(row)
    group.tokens += tokensOf(row)
    if (cost !== null) group.cost = (group.cost ?? 0) + cost
    groups.set(group.name, group)
  }
  return [...groups.values()].sort((a, b) => b.tokens - a.tokens)
}

function Select<Value extends string>({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: Value
  options: readonly (readonly [Value, string])[]
  onChange: (value: Value) => void
}): React.JSX.Element {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => onChange(options.find(([option]) => option === event.target.value)?.[0] ?? value)}
      className="h-7 max-w-56 min-w-0 rounded-md border border-border bg-background px-2 text-xs"
    >
      {options.map(([option, name]) => (
        <option key={option} value={option}>
          {name}
        </option>
      ))}
    </select>
  )
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }): React.JSX.Element {
  return (
    <div className="min-w-0 rounded-lg px-3 py-2.5 ring-1 ring-border">
      <div className="truncate text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate text-lg tabular-nums">{value}</div>
      {note && <div className="truncate text-[10.5px] text-muted-foreground">{note}</div>}
    </div>
  )
}

function DailyChart({ days, rows }: { days: string[]; rows: UsageRow[] }): React.JSX.Element {
  const byDay = new Map(days.map((day) => [day, { input: 0, output: 0 }]))
  for (const row of rows) {
    const totals = byDay.get(row.day)
    if (!totals) continue
    totals.input += row.input
    totals.output += row.output
  }
  const peak = Math.max(1, ...[...byDay.values()].map(({ input, output }) => input + output))
  return (
    <div className="px-2">
      <div className="mb-1.5 flex justify-end gap-3 text-[10.5px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="size-2 rounded-sm bg-primary" /> output
        </span>
        <span className="flex items-center gap-1">
          <span className="size-2 rounded-sm bg-foreground/30" /> input
        </span>
        <span>cache excluded</span>
      </div>
      <div className="flex h-28 items-end justify-center gap-px border-b border-border">
        {[...byDay].map(([day, { input, output }]) => (
          <div key={day} title={`${day}\ninput ${compact(input)}\noutput ${compact(output)}`} className="flex h-full max-w-6 min-w-px flex-1 flex-col justify-end">
            <div style={{ height: `${(output / peak) * 100}%` }} className="rounded-t-[2px] bg-primary" />
            <div style={{ height: `${(input / peak) * 100}%` }} className="bg-foreground/30" />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10.5px] text-muted-foreground tabular-nums">
        <span>{days[0]}</span>
        <span>{days.at(-1)}</span>
      </div>
    </div>
  )
}

const BREAKDOWN_ROWS = 12

/** The biggest groups, the rest summed into one row */
function Breakdown({ title, groups }: { title: string; groups: Group[] }): React.JSX.Element {
  const most = groups[0]?.tokens || 1
  const rest = groups.slice(BREAKDOWN_ROWS)
  const restRow: Group[] = rest.length
    ? [
        {
          name: `${rest.length} more`,
          tokens: rest.reduce((total, group) => total + group.tokens, 0),
          cost: rest.some((group) => group.cost !== null) ? rest.reduce((total, group) => total + (group.cost ?? 0), 0) : null
        }
      ]
    : []
  return (
    <Card title={title}>
      <div className="grid grid-cols-[minmax(0,14rem)_1fr_auto_auto] items-center gap-x-3 gap-y-1.5 px-2 text-xs">
        {[...groups.slice(0, BREAKDOWN_ROWS), ...restRow].map(({ name, tokens, cost }) => (
          <Fragment key={name}>
            <span className="truncate" title={name}>
              {name}
            </span>
            <span className="h-1.5 overflow-hidden rounded-full bg-foreground/10">
              <span style={{ width: `${(tokens / most) * 100}%` }} className="block h-full rounded-full bg-primary" />
            </span>
            <span className="text-right text-muted-foreground tabular-nums">{compact(tokens)}</span>
            <span className="w-14 text-right tabular-nums">{cost === null ? '-' : usd(cost)}</span>
          </Fragment>
        ))}
      </div>
    </Card>
  )
}

function Dashboard(): React.JSX.Element {
  const [usage, setUsage] = useState<Usage | null>(null)
  const [error, setError] = useState('')
  const [agent, setAgent] = useState('all')
  const [project, setProject] = useState('all')
  const [range, setRange] = useState<Range>('month')

  useEffect(() => {
    bridge
      .invoke<Usage>('usage')
      .then(setUsage)
      .catch((reason: unknown) => setError(errorMessage(reason)))
  }, [])

  const view = useMemo(() => {
    if (!usage) return null
    const { rows, prices } = usage
    const costOf = (row: UsageRow): number | null => {
      const price = prices[row.model]
      return price ? row.input * price[0] + row.output * price[1] + row.cacheRead * price[2] + row.cacheWrite * price[3] : null
    }
    const start = rangeStart(range, rows)
    const inRange = rows.filter((row) => row.day >= start)
    const shown = inRange.filter((row) => (agent === 'all' || row.agent === agent) && (project === 'all' || row.project === project))
    const sum = (pick: (row: UsageRow) => number, of = shown): number => of.reduce((total, row) => total + pick(row), 0)
    return {
      shown,
      costOf,
      days: daysFrom(start),
      agents: groupBy(rows, (row) => row.agent, costOf).map(({ name }) => [name, agentName(name)] as const),
      projects: groupBy(inRange, (row) => row.project, costOf).map(({ name }) => [name, name] as const),
      cost: sum((row) => costOf(row) ?? 0),
      unpriced: sum(
        tokensOf,
        shown.filter((row) => costOf(row) === null)
      ),
      input: sum((row) => row.input),
      output: sum((row) => row.output),
      cacheRead: sum((row) => row.cacheRead),
      cacheWrite: sum((row) => row.cacheWrite)
    }
  }, [usage, agent, project, range])

  if (error) return <p className="px-2 text-xs text-red-400">Couldn't read the session logs: {error}</p>
  if (!view) return <p className="px-2 text-xs text-muted-foreground">Reading Claude and Codex session logs. The first time takes a minute.</p>
  const { shown, costOf, days, cost, unpriced, input, output, cacheRead, cacheWrite } = view

  return (
    <div data-setting="Agent usage">
      <Card title="Usage">
        <div className="mb-3 flex flex-wrap gap-2 px-2">
          <Select label="Agent" value={agent} options={[['all', 'All agents'], ...view.agents]} onChange={setAgent} />
          <Select label="Project" value={project} options={[['all', 'All projects'], ...view.projects]} onChange={setProject} />
          <Select label="Period" value={range} options={RANGES} onChange={setRange} />
        </div>
        <div className="mb-4 grid grid-cols-[repeat(auto-fit,minmax(7.5rem,1fr))] gap-2 px-2">
          <Stat label="Est. cost" value={usd(cost)} note={unpriced > 0 ? `excl. ${compact(unpriced)} unpriced` : 'API list prices'} />
          <Stat label="Total tokens" value={compact(input + output + cacheRead + cacheWrite)} />
          <Stat label="Input" value={compact(input)} />
          <Stat label="Output" value={compact(output)} />
          <Stat label="Cache" value={compact(cacheRead + cacheWrite)} note={`${compact(cacheRead)} read · ${compact(cacheWrite)} write`} />
        </div>
      </Card>
      <Card title="Daily tokens">
        <DailyChart days={days} rows={shown} />
      </Card>
      <Breakdown title="By model" groups={groupBy(shown, (row) => row.model, costOf)} />
      {project === 'all' && <Breakdown title="By project" groups={groupBy(shown, (row) => row.project, costOf)} />}
    </div>
  )
}

/** Settings search shows it only when asked for, so typing doesn't read every session log */
export function AgentUsage(): React.JSX.Element | null {
  return useSettingMatch('Agent usage tokens cost models projects') ? <Dashboard /> : null
}
