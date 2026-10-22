import { useEffect, useState } from 'react'
import { Modal, reposOf } from '../../dialogs'
import type { Routine, RoutineEvent, RoutinePermission, RoutinePlace } from '../../ipc/api'
import { Icon } from '../../lib/icons'
import { pickFolder } from '../../lib/native'
import type { ShellView } from '../../shell/Shell'
import { FIcon } from '../agents/icons'
import { cronOf, EVENTS, EVERY, fixDraft, isPrEvent, parseAmount, parseCron, problem, webhookUrl, whenLabel, whenText, type Every } from './logic'
import { toast } from './toasts'

const AGENT = { claude: 'Claude', codex: 'Codex' } as const
const PERMISSIONS: [RoutinePermission, string][] = [['readOnly', 'Read only'], ['editFiles', 'Edit files'], ['anything', 'Anything']]
const OTHER = '\u0000other'

function Segs<T extends string>({ value, options, onChange }: { value: T; options: (readonly [T, string, string?])[]; onChange: (value: T) => void }) {
  return (
    <div className="seg">
      {options.map(([v, label, icon]) => (
        <button key={v} type="button" className={v === value ? 'on' : ''} onClick={() => onChange(v)}>
          {icon === 'claude' || icon === 'codex' ? <Icon name={icon} /> : null}
          {label}
        </button>
      ))}
    </div>
  )
}

/** The next fire times of a schedule, or why the cron is wrong */
function useNextFires(view: ShellView, cron: string | null): string | null {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    if (cron === null) return setText(null)
    let live = true
    view.api.routineNextFires(cron, 3).then(
      (at) => live && setText(at.length ? `Next: ${at.map((ms) => whenLabel(ms)).join(', ')}` : 'Never fires'),
      (e: unknown) => live && setText(`Not a valid schedule: ${e instanceof Error ? e.message : String(e)}`)
    )
    return () => void (live = false)
  }, [view.api, cron])
  return text
}

/** "New routine" / "Edit routine": the routine's trigger, place, agent, prompt, budget and permissions */
export function Editor({ view, initial, onClose }: { view: ShellView; initial: Routine; onClose: () => void }) {
  const { api } = view
  const repos = reposOf(view)
  const fallback = repos[0]?.path ?? null
  const [r, setDraft] = useState(() => fixDraft(initial, fallback))
  const [custom, setCustom] = useState(initial.trigger.kind === 'schedule' && parseCron(initial.trigger.cron).every === 'custom')
  const [budget, setBudget] = useState({ cost: initial.budget.maxCost?.toString() ?? '', turns: initial.budget.maxTurns?.toString() ?? '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const isNew = !r.id
  const cron = r.trigger.kind === 'schedule' ? r.trigger.cron : null
  const next = useNextFires(view, cron)

  const set = (patch: Partial<Routine>) => setDraft((d) => fixDraft({ ...d, ...patch }, fallback))
  const draft: Routine = { ...r, budget: { maxCost: parseAmount(budget.cost), maxTurns: parseAmount(budget.turns) } }
  const why = problem(draft) ?? (next?.startsWith('Not a valid') ? next : null)

  const schedule = cron === null ? null : parseCron(cron)
  const every: Every = custom ? 'custom' : (schedule?.every ?? 'weekdays')
  const at = schedule?.at ?? '09:00'
  const setSchedule = (nextEvery: Every, nextAt: string) => {
    setCustom(nextEvery === 'custom')
    set({ trigger: { kind: 'schedule', cron: cronOf(nextEvery, nextAt, cron ?? '0 9 * * 1-5') } })
  }

  const save = () => {
    setBusy(true)
    api.routinePut(draft).then(
      (saved) => {
        setBusy(false)
        toast({ icon: 'clock', title: isNew ? `${saved.name} is on` : `${saved.name} saved`, body: `${whenText(saved)} · ${AGENT[saved.agent]}` })
        // A new webhook routine stays open: its URL exists only now
        if (isNew && saved.trigger.kind === 'webhook') setDraft(saved)
        else onClose()
      },
      (e: unknown) => (setBusy(false), setError(e instanceof Error ? e.message : String(e)))
    )
  }
  const remove = () => {
    setBusy(true)
    api.routineRemove(r.id).then(
      () => (toast({ icon: 'clock', title: `${r.name} deleted`, body: 'Its past runs stay in History' }), onClose()),
      (e: unknown) => (setBusy(false), setError(e instanceof Error ? e.message : String(e)))
    )
  }

  const repoOptions = r.repo && !repos.some((x) => x.path === r.repo) ? [{ path: r.repo, name: r.repo.slice(r.repo.lastIndexOf('/') + 1) }, ...repos] : repos
  const pickRepo = (value: string) => {
    if (value !== OTHER) return set({ repo: value || null })
    void pickFolder(view.home).then((path) => path && set({ repo: path }))
  }
  const vars = r.trigger.kind === 'event' ? EVENTS[r.trigger.event][2] : r.trigger.kind === 'webhook' ? '{body}' : ''
  const url = r.trigger.kind === 'webhook' && r.trigger.token ? webhookUrl(r.trigger.token) : null
  const curl = url && `curl -X POST ${url} -d 'Deploy failed on staging'`

  return (
    <Modal className="nw rt" busy={busy} onClose={onClose}>
      <h3>
        <Icon name="clock" />
        {isNew ? 'New routine' : 'Edit routine'}
      </h3>
      <div className="frow2">
        <div className="fld">
          <label>Name</label>
          <input autoFocus={isNew} value={r.name} placeholder="Review PRs that ask for me" spellCheck={false} onChange={(e) => set({ name: e.target.value })} />
        </div>
        <div className="fld" style={{ flex: 'none' }}>
          <label>Agent</label>
          <Segs value={r.agent} options={[['claude', 'Claude', 'claude'], ['codex', 'Codex', 'codex']]} onChange={(agent) => set({ agent })} />
        </div>
      </div>
      <div className="fld">
        <label>Runs</label>
        <Segs
          value={r.trigger.kind}
          options={[['schedule', 'On a schedule'], ['event', 'On an event'], ['webhook', 'On a webhook']]}
          onChange={(kind) => {
            if (kind === r.trigger.kind) return
            setCustom(false)
            set({ trigger: kind === 'schedule' ? { kind, cron: '0 9 * * 1-5' } : kind === 'event' ? { kind, event: 'reviewRequested' } : { kind, token: '' } })
          }}
        />
      </div>
      {r.trigger.kind === 'schedule' && (
        <>
          <div className="frow2">
            <div className="fld">
              <label>Every</label>
              <select value={every} onChange={(e) => setSchedule(e.target.value as Every, at)}>
                {(Object.keys(EVERY) as Every[]).map((k) => (
                  <option key={k} value={k}>
                    {EVERY[k]}
                  </option>
                ))}
              </select>
            </div>
            {every === 'custom' ? (
              <div className="fld">
                <label>Cron</label>
                <input className="mono" value={cron ?? ''} placeholder="0 9 * * 1-5" spellCheck={false} onChange={(e) => set({ trigger: { kind: 'schedule', cron: e.target.value } })} />
              </div>
            ) : (
              <div className="fld">
                <label>At</label>
                <input type="time" value={at} disabled={every === 'hour'} onChange={(e) => e.target.value && setSchedule(every, e.target.value)} />
              </div>
            )}
          </div>
          {next && <div className={`nwchk ${next.startsWith('Not a valid') ? 'err' : ''}`}>{next}</div>}
          <div className="fld">
            <label>If the Mac is asleep</label>
            <Segs value={r.asleep} options={[['catchUp', 'Run when it wakes'], ['skip', 'Skip the run']]} onChange={(asleep) => set({ asleep })} />
          </div>
        </>
      )}
      {r.trigger.kind === 'event' && (
        <div className="fld">
          <label>
            Event <span className="dim">· {EVENTS[r.trigger.event][1]}</span>
          </label>
          <Segs<RoutineEvent> value={r.trigger.event} options={(Object.keys(EVENTS) as RoutineEvent[]).map((k) => [k, EVENTS[k][0]] as const)} onChange={(event) => set({ trigger: { kind: 'event', event } })} />
        </div>
      )}
      {r.trigger.kind === 'webhook' && (
        <div className="fld">
          <label>
            Webhook <span className="dim">· only this Mac can call it. The body is {'{body}'}</span>
          </label>
          {curl && url ? (
            <div className="rthook">
              <pre className="snip mono">{curl}</pre>
              <div className="a">
                <button type="button" className="btn sm" onClick={() => void navigator.clipboard.writeText(url).then(() => setCopied(true))}>
                  <FIcon name="copy" />
                  {copied ? 'Copied' : 'Copy URL'}
                </button>
                <button type="button" className="btn sm" title="The old URL stops working when you save" onClick={() => (setCopied(false), set({ trigger: { kind: 'webhook', token: '' } }))}>
                  New token
                </button>
              </div>
            </div>
          ) : (
            <div className="nwchk">The URL and its token are made when you {isNew ? 'create' : 'save'} the routine</div>
          )}
        </div>
      )}
      <div className="frow2">
        <div className="fld">
          <label>Where</label>
          <select value={r.repo ?? ''} onChange={(e) => pickRepo(e.target.value)}>
            {r.trigger.kind === 'event' && <option value="">{isPrEvent(r) ? "The PR's repo" : "The ticket's repo"}</option>}
            {repoOptions.map((x) => (
              <option key={x.path} value={x.path}>
                {x.name}
              </option>
            ))}
            <option value={OTHER}>Other folder...</option>
          </select>
        </div>
        <div className="fld" style={{ flex: 'none' }}>
          <label>Each run in</label>
          <Segs<RoutinePlace>
            value={r.place}
            options={[['root', 'Repo folder'], ['newWorktree', 'New worktree'], ...(isPrEvent(r) ? [['prWorktree', "PR's worktree"] as const] : [])]}
            onChange={(place) => set({ place })}
          />
        </div>
      </div>
      <div className="fld">
        <label>
          Prompt
          {vars && (
            <span className="dim">
              {' '}
              · <span className="mono">{vars}</span>
            </span>
          )}
        </label>
        <textarea value={r.prompt} placeholder="Summarize yesterday: my commits and PRs waiting on me" onChange={(e) => set({ prompt: e.target.value })} />
      </div>
      <div className="frow2">
        <div className="fld" style={{ flex: 'none' }}>
          <label>Agent may</label>
          <Segs value={r.permission} options={PERMISSIONS} onChange={(permission) => set({ permission })} />
        </div>
        <div className="fld" style={{ flex: '0 0 110px' }}>
          <label>Budget per run, $</label>
          <input value={budget.cost} inputMode="decimal" placeholder="No limit" onChange={(e) => setBudget({ ...budget, cost: e.target.value })} />
        </div>
        <div className="fld" style={{ flex: '0 0 90px' }}>
          <label>Max turns</label>
          <input value={budget.turns} inputMode="numeric" placeholder="No limit" onChange={(e) => setBudget({ ...budget, turns: e.target.value })} />
        </div>
      </div>
      <div className="opts">
        <label className="chk">
          <input type="checkbox" checked={r.mayPush} onChange={(e) => set({ mayPush: e.target.checked })} />
          May push, open PRs and post comments <span className="dim">{r.mayPush ? '' : 'off: it commits locally and you push'}</span>
        </label>
      </div>
      {r.permission === 'anything' && (
        <div className="nwchk err">
          <Icon name="alert" />
          <span className="grow">Runs with {r.agent === 'claude' ? '--dangerously-skip-permissions' : 'full access'}: commands run without asking</span>
        </div>
      )}
      {error && (
        <div className="nwchk err">
          <Icon name="alert" />
          <span className="grow">{error}</span>
        </div>
      )}
      <div className="mft">
        {!isNew && (
          <button className="btn" disabled={busy} onClick={remove}>
            Delete
          </button>
        )}
        <span className="grow" />
        {why && <span className="dim trunc">{why}</span>}
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn pri" disabled={busy || !!why} onClick={save}>
          {isNew ? 'Create routine' : 'Save'}
        </button>
      </div>
    </Modal>
  )
}
