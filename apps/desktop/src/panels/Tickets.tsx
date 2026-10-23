import { useState } from 'react'
import type { Ticket, TicketList } from '../ipc/api'
import { FIcon } from '../features/agents/icons'
import { Icon } from '../lib/icons'
import type { ShellView } from '../shell/Shell'
import { Head, PIcon } from './common'
import { ago } from './logic'

const KIND: Record<Ticket['kind'], string> = { task: '', bug: 'red', story: 'green' }

/** The filters outlive switching panels */
let last = { status: '', q: '' }

/** Your Jira (and Notion) tickets; Start opens a worktree on the ticket's branch with an agent briefed on it */
export function Tickets({ view, data, refresh, repo }: { view: ShellView; data: TicketList; refresh: () => void; repo: string | null }) {
  const [filters, keep] = useState(last)
  const set = (patch: Partial<typeof last>) => keep((last = { ...filters, ...patch }))
  const statuses = [...new Set([...data.tickets.map((t) => t.status), filters.status].filter(Boolean))].sort((a, b) => a.localeCompare(b))
  const q = filters.q.trim().toLowerCase()
  const list = data.tickets.filter((t) => (!filters.status || t.status === filters.status) && (!q || `${t.key} ${t.title} ${t.project ?? ''}`.toLowerCase().includes(q)))
  return (
    <>
      <Head title="Tickets">
        <button className="icon sm" onClick={refresh} title="Refresh">
          <PIcon name="reload" />
        </button>
      </Head>
      <label className="filter">
        <Icon name="search" />
        <input placeholder="Search tickets" value={filters.q} onChange={(e) => set({ q: e.target.value })} onKeyDown={(e) => e.key === 'Escape' && set({ q: '' })} spellCheck={false} />
      </label>
      <div className="pfil">
        <select value={filters.status} onChange={(e) => set({ status: e.target.value })} aria-label="Status">
          <option value="">Any status</option>
          {statuses.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      {data.errors.map((e) => (
        <div key={e.source} className="banner red">
          <Icon name="alert" />
          <span className="grow">
            <b>{e.source === 'jira' ? 'Jira' : 'Notion'}:</b> {e.message}
          </span>
        </div>
      ))}
      <div className="pscroll">
        {list.length ? (
          list.map((t) => (
            <div key={`${t.source}${t.key}`} className="pr">
              <FIcon name={t.source} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="t">
                  {t.url ? (
                    <a
                      href={t.url}
                      onClick={(e) => {
                        e.preventDefault()
                        void view.api.openUrl(t.url ?? '')
                      }}
                      title="Open in browser"
                    >
                      {t.title}
                    </a>
                  ) : (
                    t.title
                  )}
                </div>
                <div className="m dots">
                  <span className="mono">{t.source === 'jira' ? t.key : (t.project ?? 'Notion')}</span>
                  {t.source === 'jira' && t.project && <span className="mid">{t.project}</span>}
                  {t.updatedAt && <span className="mid">{ago(Date.parse(t.updatedAt))}</span>}
                </div>
                <div className="m">
                  <span className="tag">{t.status}</span>
                  {t.kind !== 'task' && <span className={`tag ${KIND[t.kind]}`}>{t.kind}</span>}
                </div>
                <div className="a">
                  <button className="btn sm" onClick={() => view.openDialog({ kind: 'newWorktree', repo: repo ?? undefined, ticket: t })}>
                    <PIcon name="tree" />
                    Start in worktree
                  </button>
                </div>
              </div>
            </div>
          ))
        ) : (
          <div className="empty">{data.tickets.length ? 'No tickets match' : 'No tickets assigned to you'}</div>
        )}
      </div>
    </>
  )
}
