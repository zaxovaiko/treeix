import { useCallback, useEffect, useState } from 'react'
import type { AgentUsage, Api, UsageLimits } from '../../ipc/api'
import { Icon } from '../../lib/icons'
import { useContextMenu } from '../../panels/common'
import { IS_MAC } from '../../shell/shortcuts'
import { Pop } from './Pop'
import { useSettings } from './settings'
import { compact, level, pillParts, summarize, untilLabel, usd, WINDOW_LABEL, type LimitAgent, type Share } from './usage'

const AGENT_NAME: Record<LimitAgent, string> = { claude: 'Claude', codex: 'Codex' }

export function useLimits(api: Api, on: boolean) {
  const [limits, setLimits] = useState<UsageLimits | null>(null)
  useEffect(() => {
    if (!on) return
    let live = true
    void api.usageLimits().then((l) => live && setLimits(l), () => {})
    const stop = api.onUsageLimits(setLimits)
    return () => {
      live = false
      stop()
    }
  }, [api, on])
  return on ? limits : null
}

/** Title bar: plan limits of the chosen window; click for both windows per agent and the last week's tokens */
export function UsagePill({ api }: { api: Api }) {
  const settings = useSettings(api)
  const inMenuBar = IS_MAC && !!settings && ['weekly', 'fiveHour', 'rings'].includes(settings.usage.tray)
  const on = !!settings?.features.usage && settings.usage.pill && !inMenuBar
  const limits = useLimits(api, on)
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const close = useCallback(() => setAnchor(null), [])
  const [menu, openMenu] = useContextMenu()
  const parts = settings ? pillParts(limits, settings.usage.window) : []
  if (!on || !parts.length || !limits) return null
  const hint = parts.map(({ agent, main, other }) => `${AGENT_NAME[agent]} ${main.label} ${main.percent}%${other ? `, ${other.label} ${other.percent}%` : ''}`).join(' · ')
  return (
    <>
      <button
        className="pill usage"
        title={`${hint}. Click for usage, right-click to hide`}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect())}
        onContextMenu={openMenu([{ label: 'Hide usage meter', icon: 'x', run: () => void api.updateSettings({ usage: { pill: false } }) }])}
      >
        {/* A ring around each agent's icon fills with the chosen window's share; the other window is in the tooltip */}
        {parts.map(({ agent, main }) => (
          <span key={agent} className={`pagent ${level(main.percent)}`}>
            <span className="ring" style={{ '--p': Math.min(100, main.percent) }}>
              <Icon name={agent} />
            </span>
            {main.percent}%
          </span>
        ))}
      </button>
      {menu}
      {anchor && (
        <Pop anchor={anchor} className="upop" onClose={close}>
          <UsageDetails api={api} limits={limits} />
        </Pop>
      )}
    </>
  )
}

export function UsageDetails({ api, limits }: { api: Api; limits: UsageLimits }) {
  const [usage, setUsage] = useState<AgentUsage | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    void api.agentUsage().then(setUsage, () => setFailed(true))
  }, [api])
  const week = usage && summarize(usage)
  return (
    <>
      {(['claude', 'codex'] as const).map((agent) => {
        const own = limits[agent]
        if (!own) return null
        return (
          <div key={agent} className="ulim">
            <div className="mlabel">
              <Icon name={agent} />
              {AGENT_NAME[agent]}
            </div>
            {(['fiveHour', 'weekly'] as const).map((name) => {
              const w = own[name]
              if (!w) return null
              const until = untilLabel(w.resetsAt)
              return (
                <div key={name} className="lim">
                  <div className="l">
                    <span>{WINDOW_LABEL[name]}</span>
                    <span className="dim">
                      {Math.round(w.usedPercent)}%{until && ` · resets in ${until}`}
                    </span>
                  </div>
                  <div className={`bar ${level(w.usedPercent)}`}>
                    <b style={{ width: `${Math.min(100, w.usedPercent)}%` }} />
                  </div>
                </div>
              )
            })}
          </div>
        )
      })}
      <div className="msep" />
      <div className="mlabel">
        Last 7 days
        <span className="grow" />
        {week && <span className="num">{usd(week.cost)} API-equivalent</span>}
      </div>
      {failed ? (
        <div className="uempty">Could not read the agents' logs</div>
      ) : !week ? (
        <div className="uempty">Reading the agents' logs...</div>
      ) : !week.tokens ? (
        <div className="uempty">No tokens spent this week</div>
      ) : (
        <div className="ulim">
          <div className="uchart" title="Tokens per day">
            {week.days.map((d) => (
              <i key={d.name} title={`${d.name}: ${compact(d.tokens)} tokens · ${usd(d.cost)}`} style={{ height: `${Math.max(4, (d.tokens / Math.max(...week.days.map((x) => x.tokens))) * 100)}%` }} />
            ))}
          </div>
          <Shares title="By model" shares={week.models} />
          <Shares title="By project" shares={week.projects} label={folderLabels(week.projects)} />
        </div>
      )}
    </>
  )
}

/** A project's last folder, with its parent when another project ends in the same folder */
function folderLabels(shares: Share[]): (name: string) => string {
  const tail = (path: string, parts: number) => path.split('/').slice(-parts).join('/')
  const counts = new Map<string, number>()
  for (const s of shares) counts.set(tail(s.name, 1), (counts.get(tail(s.name, 1)) ?? 0) + 1)
  return (name) => tail(name, (counts.get(tail(name, 1)) ?? 0) > 1 ? 2 : 1)
}

function Shares({ title, shares, label = (name) => name }: { title: string; shares: Share[]; label?: (name: string) => string }) {
  return (
    <>
      <div className="mlabel">{title}</div>
      {shares.slice(0, 4).map((s) => (
        <div key={s.name} className="ushare" title={s.name}>
          <span className="trunc">{label(s.name)}</span>
          <span className="num">{compact(s.tokens)}</span>
          <span className="num">{usd(s.cost)}</span>
        </div>
      ))}
    </>
  )
}
