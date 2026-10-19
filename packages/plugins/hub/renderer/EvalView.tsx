import { useEffect, useRef, useState } from 'react'
import { PANE_HEADER, useHost } from '@treeix/sdk'
import { openMenu } from '@treeix/app/contextMenu'
import { Icon } from '@treeix/app/Icon'
import { Select } from '@treeix/app/Picker'
import { errorMessage, IconButton } from '@treeix/app/ui'
import { CRON_PRESETS, isCron } from '../shared/cron'
import { batchesOf, CHECK_LABEL, type EvalCase, type EvalCheck, type EvalResult, type EvalSuite } from '../shared/evals'
import { MAX_SCORE } from '../shared/workflow'
import { WholeNumber } from './AgentEditor'
import { hubAgents, hubApi, hubBack, hubEvalsRunning, hubSelection, hubWorkflows } from './store'

const SAVE_DELAY_MS = 500
const HISTORY = 12
const OFF = 'off'
/** Suites suit the night, when nobody waits on the machine */
const NIGHTLY = { cron: '0 3 * * *', label: 'Every night at 3:00' }
const FIELD = 'w-full rounded-md border border-input bg-muted px-2.5 py-1.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-primary'
const LABEL = 'flex flex-col gap-1.5 text-xs text-muted-foreground'

const blankCheck = (kind: EvalCheck['kind'], agent: string): EvalCheck => {
  const id = crypto.randomUUID()
  if (kind === 'command') return { id, kind, command: '', folder: null }
  if (kind === 'judge') return { id, kind, agent, rubric: '', minScore: 8 }
  return { id, kind, value: '' }
}

function CheckFields({ check, onChange }: { check: EvalCheck; onChange: (check: EvalCheck) => void }): React.JSX.Element {
  const agents = hubAgents.useValue()
  switch (check.kind) {
    case 'contains':
    case 'regex':
      return (
        <input
          value={check.value}
          onChange={(event) => onChange({ ...check, value: event.target.value })}
          placeholder={check.kind === 'contains' ? 'Text the output must have, any case' : 'A pattern, e.g. ^PR: https://'}
          className={`${FIELD} ${check.kind === 'regex' ? 'font-mono text-xs' : ''}`}
        />
      )
    case 'command':
      return (
        <div className="flex flex-col gap-2">
          <input
            value={check.command}
            onChange={(event) => onChange({ ...check, command: event.target.value })}
            placeholder='Passes on exit 0, the output in $OUTPUT, e.g. bun test or echo "$OUTPUT" | grep -q PR'
            className={`${FIELD} font-mono text-xs`}
          />
          <input
            value={check.folder ?? ''}
            onChange={(event) => onChange({ ...check, folder: event.target.value.trim() || null })}
            placeholder="Folder, else where the first agent works"
            className={`${FIELD} font-mono text-xs`}
          />
        </div>
      )
    case 'judge':
      return (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <Select
                title="The agent that scores it, best on another model"
                value={check.agent}
                options={agents.map((agent) => ({ value: agent.id, label: agent.name }))}
                onChange={(agent) => onChange({ ...check, agent })}
              />
            </div>
            <label className="flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground">
              Passes at
              <WholeNumber min={1} max={MAX_SCORE} value={check.minScore} onChange={(minScore) => onChange({ ...check, minScore })} className={`${FIELD} w-14`} />
            </label>
          </div>
          <textarea
            value={check.rubric}
            onChange={(event) => onChange({ ...check, rubric: event.target.value })}
            placeholder="What it judges by, e.g. Meets every acceptance criterion, adds tests, changes nothing else"
            rows={2}
            className={FIELD}
          />
        </div>
      )
  }
}

function CaseCard({
  item,
  result,
  onChange,
  onRemove
}: {
  item: EvalCase
  result: EvalResult | null
  onChange: (item: EvalCase) => void
  onRemove: () => void
}): React.JSX.Element {
  const agents = hubAgents.useValue()
  const [open, setOpen] = useState(item.input === '')
  const setCheck = (next: EvalCheck): void => onChange({ ...item, checks: item.checks.map((check) => (check.id === next.id ? next : check)) })
  const outcome = (check: string) => result?.checks.find((entry) => entry.check === check) ?? null
  const runFailed = result?.checks.find((entry) => entry.check === 'run') ?? null
  return (
    <div data-case={item.id} className="flex flex-col rounded-lg border border-border">
      <div className="flex h-10 items-center gap-2 pr-1.5 pl-3">
        <Icon
          name={result ? (result.pass ? 'check' : 'close') : 'pointer'}
          className={`size-3.5 shrink-0 ${result ? (result.pass ? 'text-emerald-400' : 'text-red-400') : 'text-muted-foreground'}`}
        />
        <input
          value={item.name}
          onChange={(event) => onChange({ ...item, name: event.target.value })}
          aria-label="Case name"
          className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
        />
        {result?.score != null && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{`${Math.round(result.score * 10) / 10}/${MAX_SCORE}`}</span>}
        {result?.runId && (
          <IconButton label="Open the run" onClick={() => hubSelection.set(`run:${result.runId}`)}>
            <Icon name="external" className="size-3.5" />
          </IconButton>
        )}
        <IconButton label={open ? 'Fold' : 'Edit the case'} onClick={() => setOpen(!open)}>
          <Icon name="chevron" className={`size-3.5 ${open ? 'rotate-90' : ''}`} />
        </IconButton>
        <IconButton label="Remove the case" onClick={onRemove}>
          <Icon name="trash" className="size-3.5" />
        </IconButton>
      </div>
      {runFailed && <p className="px-3 pb-2.5 text-xs text-red-400">{runFailed.detail}</p>}
      {open && (
        <div className="flex flex-col gap-3 border-t border-border p-3">
          <label className={LABEL}>
            Input
            <textarea value={item.input} onChange={(event) => onChange({ ...item, input: event.target.value })} placeholder="What the run starts with" rows={3} className={FIELD} />
          </label>
          <label className={LABEL}>
            Reference, optional
            <textarea
              value={item.reference ?? ''}
              onChange={(event) => onChange({ ...item, reference: event.target.value || null })}
              placeholder="A good output; judges compare with it"
              rows={2}
              className={FIELD}
            />
          </label>
        </div>
      )}
      <div className="flex flex-col gap-2 border-t border-border p-3">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          Checks
          <button
            onClick={(event) =>
              openMenu(
                event,
                (Object.keys(CHECK_LABEL) as EvalCheck['kind'][]).map((kind) => ({
                  label: CHECK_LABEL[kind],
                  run: () => (onChange({ ...item, checks: [...item.checks, blankCheck(kind, agents[0]?.id ?? '')] }), setOpen(true))
                }))
              )
            }
            className="flex items-center gap-1 text-[11px] hover:text-foreground"
          >
            <Icon name="plus" className="size-3" />
            Add
          </button>
        </div>
        {item.checks.length === 0 && <span className="text-[11px] text-muted-foreground">None: the case passes when the run finishes.</span>}
        {item.checks.map((check) => {
          const done = outcome(check.id)
          return (
            <div key={check.id} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 text-xs">
                {done && <Icon name={done.pass ? 'check' : 'close'} className={`size-3 shrink-0 ${done.pass ? 'text-emerald-400' : 'text-red-400'}`} />}
                <span className="font-medium">{CHECK_LABEL[check.kind]}</span>
                {!open && (
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {check.kind === 'command' ? check.command : check.kind === 'judge' ? check.rubric : check.value}
                  </span>
                )}
                <span className="flex-1" />
                {done?.runId && (
                  <button onClick={() => hubSelection.set(`run:${done.runId}`)} className="text-[11px] text-muted-foreground hover:text-foreground">
                    The judge's run
                  </button>
                )}
                <IconButton label="Remove the check" onClick={() => onChange({ ...item, checks: item.checks.filter((entry) => entry.id !== check.id) })}>
                  <Icon name="close" className="size-3" />
                </IconButton>
              </div>
              {open && <CheckFields check={check} onChange={setCheck} />}
              {done && done.detail && <p className={`text-[11px] break-words whitespace-pre-wrap ${done.pass ? 'text-muted-foreground' : 'text-red-400'}`}>{done.detail}</p>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** A suite: its cases and their checks, editable, with how its runs went */
export function EvalView({ suite }: { suite: EvalSuite }): React.JSX.Element {
  const host = useHost()
  const agents = hubAgents.useValue()
  const workflows = hubWorkflows.useValue()
  const running = hubEvalsRunning.useValue().includes(suite.id)
  const [draft, setDraft] = useState(suite)
  const [results, setResults] = useState<EvalResult[]>([])

  useEffect(() => {
    void hubApi.evalResults(suite.id).then(setResults)
    return hubApi.onEvalResult((id, result) => id === suite.id && setResults((previous) => [...previous, result]))
  }, [suite.id])

  // Edits save shortly after typing stops, and before a run reads the suite
  const saved = useRef(JSON.stringify(suite))
  const content = JSON.stringify(draft)
  const commit = (): Promise<void> => {
    if (content === saved.current) return Promise.resolve()
    saved.current = content
    return hubApi.saveEvalSuite({ ...draft, updatedAt: Date.now() }).catch((reason: unknown) => host.flash(errorMessage(reason)))
  }
  const latestCommit = useRef(commit)
  useEffect(() => {
    latestCommit.current = commit
    const timer = setTimeout(commit, SAVE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [content])
  useEffect(() => () => void latestCommit.current(), [])

  const batches = batchesOf(results)
  const latest = new Map<string, EvalResult>()
  for (const result of [...results].sort((a, b) => a.at - b.at)) latest.set(result.case, result)
  const thisRun = running ? (batches[0]?.results.length ?? 0) : null
  const target = draft.target.kind === 'workflow' ? workflows.find((workflow) => workflow.id === draft.target.id)?.name : agents.find((agent) => agent.id === draft.target.id)?.name
  const run = async (): Promise<void> => {
    await commit()
    await hubApi.runEvalSuite(suite.id).catch((reason: unknown) => host.flash(errorMessage(reason)))
  }
  const remove = (): void =>
    void (
      window.confirm(`Delete ${suite.name} and its results?`) &&
      hubApi.removeEvalSuite(suite.id).then(
        () => hubSelection.set(null),
        (reason: unknown) => host.flash(errorMessage(reason))
      )
    )
  const setCase = (next: EvalCase): void => setDraft({ ...draft, cases: draft.cases.map((item) => (item.id === next.id ? next : item)) })
  const addCase = (): void =>
    setDraft({ ...draft, cases: [...draft.cases, { id: crypto.randomUUID(), name: `Case ${draft.cases.length + 1}`, input: '', reference: null, checks: [] }] })

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className={`${PANE_HEADER} gap-2.5 pr-1.5 pl-1.5`}>
        <IconButton label="Back" onClick={hubBack}>
          <Icon name="arrowLeft" className="size-3.5" />
        </IconButton>
        <Icon name="check" className="size-4 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <input
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            aria-label="Suite name"
            className="bg-transparent text-[13px] leading-none font-medium outline-none"
          />
          <div className="truncate text-[11px] leading-none text-muted-foreground">
            {target ? `Tests ${target}, ${draft.target.kind === 'workflow' ? 'the workflow' : 'the agent alone'}` : `The ${draft.target.kind} it tests is gone`}
          </div>
        </div>
        <div className="w-44">
          <Select
            custom
            title="When it runs on its own, as a preset or a crontab line; Treeix must be open"
            value={draft.cron ?? OFF}
            options={[{ value: OFF, label: 'Only when I run it' }, ...[NIGHTLY, ...CRON_PRESETS].map((preset) => ({ value: preset.cron, label: preset.label }))]}
            onChange={(cron) => (cron === OFF || isCron(cron)) && setDraft({ ...draft, cron: cron === OFF ? null : cron })}
          />
        </div>
        <button
          onClick={() => void run()}
          disabled={running || draft.cases.length === 0}
          className="flex h-7 items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          <Icon name={running ? 'loader' : 'play'} className={`size-3 ${running ? 'animate-spin' : ''}`} />
          {running ? `Running ${thisRun} of ${draft.cases.length}` : 'Run'}
        </button>
        <IconButton label="Delete the suite" onClick={remove}>
          <Icon name="trash" className="size-3.5" />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-4">
          {batches.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span className="mr-1">Runs</span>
              {batches.slice(0, HISTORY).map((batch) => (
                <span
                  key={batch.batch}
                  title={new Date(batch.at).toLocaleString()}
                  className={`rounded px-1.5 py-0.5 tabular-nums ring-1 ${batch.passed === batch.total ? 'text-emerald-400 ring-emerald-400/40' : 'text-red-400 ring-red-400/40'}`}
                >
                  {batch.passed}/{batch.total}
                </span>
              ))}
            </div>
          )}
          {draft.cases.length === 0 && (
            <p className="text-xs text-muted-foreground">No cases yet. Add one here, or open a run that went well and save it as a case: its output becomes the bar to meet.</p>
          )}
          {draft.cases.map((item) => (
            <CaseCard
              key={item.id}
              item={item}
              result={latest.get(item.id) ?? null}
              onChange={setCase}
              onRemove={() => setDraft({ ...draft, cases: draft.cases.filter((entry) => entry.id !== item.id) })}
            />
          ))}
          <button
            onClick={addCase}
            className="flex h-8 items-center justify-center gap-1.5 rounded-lg border border-dashed border-border text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Icon name="plus" className="size-3" />
            Add a case
          </button>
        </div>
      </div>
    </div>
  )
}
