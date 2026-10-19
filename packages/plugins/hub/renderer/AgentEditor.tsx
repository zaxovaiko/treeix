import { useEffect, useRef, useState } from 'react'
import { type ChatOption, useHost } from '@treeix/sdk'
import { useAgents } from '@treeix/app/agents'
import { BOT_COLORS, BOT_MARKS, BotAvatar, BotMarkIcon } from '@treeix/app/BotAvatar'
import { FolderPicker } from '@treeix/app/FolderPicker'
import { Icon } from '@treeix/app/Icon'
import { Select, type SelectOption } from '@treeix/app/Picker'
import { Switch } from '@treeix/app/settingsUi'
import { Dialog, errorMessage } from '@treeix/app/ui'
import { CRON_PRESETS, isCron } from '../shared/cron'
import type { Subagent } from '../shared/subagents'
import { API_PRESETS, type HubAgent, MAX_TIMEOUT_MIN, type Runtime, type Schedule } from '../shared/types'
import { ASK_TIMEOUT_MIN } from '../shared/workflow'
import { useEscape } from './AskDialog'
import { hubApi, runtimeSpec } from './store'

const FIELD = 'h-9 rounded-xl bg-foreground/5 px-3 text-[13px] text-foreground ring-1 ring-transparent outline-none placeholder:text-muted-foreground/60 focus:ring-input'
const LABEL = 'flex min-w-0 flex-col gap-1.5 text-xs text-muted-foreground'

const CUSTOM_API = 'api:'

/** The runtime select's value: a registry agent, a named API, or any other API URL */
const runtimeChoice = (runtime: Runtime): string =>
  runtime.kind === 'agent' ? `agent:${runtime.agent}` : API_PRESETS.some((preset) => preset.baseUrl === runtime.baseUrl) ? `api:${runtime.baseUrl}` : CUSTOM_API

const fromChoice = (choice: string): Runtime =>
  choice.startsWith('agent:') ? { kind: 'agent', agent: choice.slice('agent:'.length) } : { kind: 'api', baseUrl: choice.slice('api:'.length) }

/** The one-character badge an agent shows */
const glyphOf = (agent: Pick<HubAgent, 'icon' | 'name'>): string => agent.icon || agent.name.trim().slice(0, 1).toUpperCase() || '?'

/** The agent's glyph on its colour */
export function AgentAvatar({ agent, size }: { agent: Pick<HubAgent, 'icon' | 'name' | 'color'>; size: number }): React.JSX.Element {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, background: agent.color, fontSize: Math.round(size * 0.5) }}
      className="grid shrink-0 place-items-center rounded-lg font-medium text-white"
    >
      {glyphOf(agent)}
    </span>
  )
}

/** The marks a bot can wear, as plain glyphs in circles; a mark it no longer offers reads as the first, as its avatar shows */
export function MarkPicker({ value, onChange }: { value: string; onChange: (mark: string) => void }): React.JSX.Element {
  const current = BOT_MARKS.find((mark) => mark === value) ?? BOT_MARKS[0]
  return (
    <div className="flex flex-wrap gap-1">
      {BOT_MARKS.map((mark) => (
        <button
          key={mark}
          aria-label={`Mark ${mark}`}
          aria-pressed={current === mark}
          onClick={() => onChange(mark)}
          className={`grid size-8 place-items-center rounded-full ${current === mark ? 'bg-foreground text-on-foreground' : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground'}`}
        >
          <BotMarkIcon mark={mark} className="size-[18px]" />
        </button>
      ))}
    </div>
  )
}

const DEFAULT_CHOICE = ''

const noEscape = (): void => undefined

const SUBAGENT_SOURCES = [
  ['/.codex/', 'Codex'],
  ['/.rulesync/', 'rulesync'],
  ['/.claude/', 'Claude']
] as const

/** A folder: one of the workspaces' projects, searched by name or path, any typed path, or one picked in Finder */
export function FolderField({
  value,
  onChange,
  placeholder = 'The selected worktree',
  className = `${FIELD} flex w-full min-w-0 items-center gap-1.5 text-left`
}: {
  value: string
  onChange: (folder: string) => void
  placeholder?: string
  className?: string
}): React.JSX.Element {
  return <FolderPicker stretch folder={value} title="Folder" placeholder={placeholder} className={className} onPick={onChange} />
}

/** Picks one of the values the runtime offers, or any typed one; `optional` adds the runtime's own default */
function OptionField({
  label,
  value,
  option,
  optional,
  loading,
  onOpen,
  onChange,
  action
}: {
  label: string
  value: string | null
  option: ChatOption | undefined
  optional: boolean
  loading: boolean
  onOpen: () => void
  onChange: (value: string | null) => void
  /** A button beside the label */
  action?: React.ReactNode
}): React.JSX.Element {
  const options: SelectOption[] = [
    ...(optional ? [{ value: DEFAULT_CHOICE, label: "The runtime's default" }] : []),
    ...(option?.values ?? []).map((entry) => ({ value: entry.value, label: entry.name, hint: entry.name === entry.value ? undefined : entry.value }))
  ]
  return (
    <div className={`${LABEL} flex-1`}>
      <span className="flex items-center justify-between">
        {label}
        {action}
      </span>
      <Select
        soft
        custom
        title={label}
        value={value ?? (optional ? DEFAULT_CHOICE : null)}
        placeholder="Required"
        options={options}
        note={loading ? 'Asking the runtime for its options…' : undefined}
        onOpen={onOpen}
        onChange={(next) => onChange(next.trim() || null)}
      />
    </div>
  )
}

/** Options each runtime offers, read once per app session since detecting starts the runtime */
const detected = new Map<string, Promise<ChatOption[]>>()

const PROMPT_FIELD =
  'resize-y rounded-xl bg-foreground/5 px-3 py-2.5 text-[13px] leading-relaxed text-foreground ring-1 ring-transparent outline-none placeholder:text-muted-foreground/60 focus:ring-input'

/** Prompts an agent gets on a schedule while Treeix runs, or the inputs a workflow starts with, each optionally shown as a notification */
export function Schedules({ schedules, onChange, workflow = false }: { schedules: Schedule[]; onChange: (schedules: Schedule[]) => void; workflow?: boolean }): React.JSX.Element {
  const patch = (id: string, next: Partial<Schedule>): void => onChange(schedules.map((entry) => (entry.id === id ? { ...entry, ...next } : entry)))
  return (
    <div className={LABEL}>
      <span className="flex items-center justify-between">
        Schedules
        <button
          onClick={() => onChange([...schedules, { id: crypto.randomUUID(), cron: CRON_PRESETS[0].cron, prompt: '', notify: true, enabled: true }])}
          className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          <Icon name="plus" className="size-3" />
          Add
        </button>
      </span>
      {schedules.length === 0 && (
        <span className="text-[11px]">
          None. A schedule {workflow ? 'runs the workflow' : 'sends the agent a prompt'} on its own, e.g. every Monday morning, while Treeix is open.
        </span>
      )}
      {schedules.map((schedule) => (
        <div key={schedule.id} className="flex flex-col gap-2 rounded-xl p-2.5 ring-1 ring-border">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <Select
                soft
                custom
                title="When, as a preset or a crontab line like 30 8 * * 1-5"
                value={schedule.cron}
                options={CRON_PRESETS.map((preset) => ({ value: preset.cron, label: preset.label }))}
                onChange={(cron) => patch(schedule.id, { cron })}
              />
            </div>
            <Switch checked={schedule.enabled} onChange={() => patch(schedule.id, { enabled: !schedule.enabled })} label="Schedule on" />
            <button
              onClick={() => onChange(schedules.filter((entry) => entry.id !== schedule.id))}
              aria-label="Remove schedule"
              className="grid size-8 shrink-0 place-items-center rounded-full hover:bg-accent hover:text-foreground"
            >
              <Icon name="trash" className="size-3.5" />
            </button>
          </div>
          {!isCron(schedule.cron) && <span className="text-[11px] text-red-400">Not a crontab line: minute hour day month weekday, e.g. 0 9 * * 1</span>}
          <textarea
            value={schedule.prompt}
            onChange={(event) => patch(schedule.id, { prompt: event.target.value })}
            placeholder={workflow ? 'The input each time, e.g. a topic to research' : "What to do each time, e.g. Sum up this week's AI news."}
            title={workflow ? 'With a command, {{input}} is the line that started the run' : 'The prompt the agent gets each time'}
            rows={3}
            className={PROMPT_FIELD}
          />
          <div className="flex gap-2">
            <label className={`${LABEL} flex-1`}>
              Command, optional
              <input
                value={schedule.command ?? ''}
                onChange={(event) => patch(schedule.id, { command: event.target.value })}
                title="Each line the command prints starts a run, as {{input}}"
                placeholder="e.g. node poll.mjs"
                className={`${FIELD} font-mono text-xs`}
              />
            </label>
            {/* A workflow's steps have their own timeouts */}
            {!workflow && (
              <label className={`${LABEL} w-24`}>
                Timeout, min
                <WholeNumber
                  min={1}
                  max={MAX_TIMEOUT_MIN}
                  value={schedule.timeoutMin ?? ASK_TIMEOUT_MIN}
                  onChange={(timeoutMin) => patch(schedule.id, { timeoutMin })}
                  className={FIELD}
                />
              </label>
            )}
          </div>
          <span className="flex items-center justify-between gap-3 text-foreground">
            Show the answer as a notification
            <Switch checked={schedule.notify} onChange={() => patch(schedule.id, { notify: !schedule.notify })} label="Show the answer as a notification" />
          </span>
        </div>
      ))}
    </div>
  )
}

/** The bot's form: a dialog, or `inline` as the body of a page that has its own way out */
export function AgentEditor({
  agent,
  onClose,
  onSaved,
  inline = false
}: {
  agent: HubAgent | null
  onClose: () => void
  onSaved: (id: string) => void
  inline?: boolean
}): React.JSX.Element {
  'use no memo' // the runtime's chat spec is read from the agent registry during render
  const host = useHost()
  // Personas run on agents of the user's own, never on another plugin's
  const runtimes = useAgents().filter((entry) => entry.chat && !entry.plugin)
  const [draft, setDraft] = useState<HubAgent>(
    () =>
      agent ?? {
        id: crypto.randomUUID(),
        name: '',
        icon: '',
        mark: BOT_MARKS[0],
        color: BOT_COLORS[0],
        runtime: { kind: 'agent', agent: runtimes[0]?.id ?? 'claude' },
        model: null,
        instructions: '',
        folder: null,
        updatedAt: 0
      }
  )
  const patch = (next: Partial<HubAgent>): void => setDraft((current) => ({ ...current, ...next }))
  const [options, setOptions] = useState<ChatOption[]>([])
  const [detecting, setDetecting] = useState(false)
  const [problem, setProblem] = useState('')
  const [more, setMore] = useState(Boolean(draft.folder || draft.schedules?.length))
  const [subagents, setSubagents] = useState<Subagent[]>([])
  useEffect(() => {
    let current = true
    void hubApi.folderSubagents(draft.folder?.trim() || null).then(
      (found) => current && setSubagents(found),
      () => current && setSubagents([])
    )
    return () => void (current = false)
  }, [draft.folder])
  const isApi = draft.runtime.kind === 'api'
  const baseUrl = draft.runtime.kind === 'api' ? draft.runtime.baseUrl : ''
  const spec = runtimeSpec(draft.runtime)
  const [keySaved, setKeySaved] = useState(false)
  const [key, setKey] = useState('')
  useEffect(() => {
    setKeySaved(false)
    if (!URL.canParse(baseUrl)) return
    let current = true
    void hubApi.hasKey(baseUrl).then(
      (saved) => current && setKeySaved(saved),
      () => undefined
    )
    return () => void (current = false)
  }, [baseUrl])
  /** A typed key is stored before anything talks to the API */
  const storeKey = async (): Promise<void> => {
    if (!isApi || !key.trim()) return
    await hubApi.setKey(baseUrl, key.trim())
    setKey('')
    setKeySaved(true)
  }

  useEscape(inline ? noEscape : onClose)

  // Detecting starts the runtime, so it waits until a list is opened; an answer for a runtime no longer picked is dropped
  const specKey = spec && (!isApi || URL.canParse(baseUrl)) ? `${spec.adapter} ${spec.command}` : null
  const pickedKey = useRef(specKey)
  pickedKey.current = specKey
  /** Lists what the runtime offers; `fresh` asks it again instead of reusing its last answer */
  const detect = (fresh: boolean): void => {
    if (!spec || !specKey || (detecting && !fresh)) return
    const isPicked = (): boolean => pickedKey.current === specKey
    setDetecting(true)
    setProblem('')
    const found =
      (fresh ? undefined : detected.get(specKey)) ??
      storeKey()
        .then(() => hubApi.detect(spec, draft.folder ?? host.defaultCwd))
        .then((list) => (detected.set(specKey, Promise.resolve(list)), list))
    found
      .then(
        (list) => isPicked() && (setOptions(list), list.length === 0 && setProblem('The runtime lists no models; type one in')),
        (reason: unknown) => isPicked() && setProblem(errorMessage(reason))
      )
      // Always stops: an answer for a runtime no longer picked still ends its turn, else nothing detects again
      .finally(() => setDetecting(false))
  }
  const effortOption = options.find((option) => option.category === 'effort')
  const detectOnOpen = (): void => void (options.length === 0 && detect(false))

  /** Copies a subagent's name, instructions and model into the bot; one from .codex runs on Codex */
  const startFrom = (path: string): void => {
    const subagent = subagents.find((candidate) => candidate.path === path)
    void hubApi.readSubagent(path).then(
      (read) => {
        if (!subagent || !read) return setProblem(`${path} is gone`)
        const codex = path.includes('/.codex/') ? runtimes.find((entry) => entry.id === 'codex') : undefined
        const model = read.model && read.model !== 'inherit' ? read.model : null
        if (codex) setOptions([])
        patch({
          name: draft.name.trim() || subagent.name,
          instructions: read.instructions,
          ...(codex ? { runtime: { kind: 'agent', agent: codex.id }, model: null } : !isApi && model ? { model } : {})
        })
      },
      (reason: unknown) => setProblem(errorMessage(reason))
    )
  }

  const name = draft.name.trim()
  // An API has no default model to fall back on
  const canSave = name !== '' && (!isApi || (URL.canParse(baseUrl) && draft.model !== null)) && (draft.schedules ?? []).every((schedule) => isCron(schedule.cron))
  const save = (): void => {
    if (!canSave) return
    storeKey()
      .then(() =>
        hubApi.save({
          ...draft,
          name,
          folder: draft.folder?.trim() || null,
          icon: glyphOf(draft),
          updatedAt: Date.now()
        })
      )
      .then(
        () => onSaved(draft.id),
        (reason: unknown) => setProblem(errorMessage(reason))
      )
  }

  const form = (
    <>
      <div className={`flex min-h-0 flex-col gap-5 ${inline ? '' : 'overflow-y-auto px-6 pt-7 pb-4'}`}>
        <div className="flex flex-col items-center gap-3">
          <BotAvatar look={{ color: draft.color, mark: draft.mark ?? '' }} className="size-16" />
          <input
            autoFocus={!inline || !agent}
            aria-label="Name"
            value={draft.name}
            onChange={(event) => patch({ name: event.target.value })}
            onKeyDown={(event) => event.key === 'Enter' && save()}
            placeholder="Name your bot"
            className="h-9 w-full bg-transparent text-center text-xl font-semibold text-foreground outline-none placeholder:text-muted-foreground/70"
          />
          <MarkPicker value={draft.mark ?? ''} onChange={(mark) => patch({ mark })} />
          <div className="flex items-center gap-2">
            {BOT_COLORS.map((swatch) => (
              <button
                key={swatch}
                aria-label={`Colour ${swatch}`}
                aria-pressed={draft.color === swatch}
                onClick={() => patch({ color: swatch })}
                style={{ background: swatch }}
                className={`size-5 rounded-full ring-offset-2 ring-offset-popover ${draft.color === swatch ? 'ring-2 ring-foreground' : ''}`}
              />
            ))}
            <label title="Any colour" className="grid size-5 cursor-pointer place-items-center rounded-full text-muted-foreground ring-1 ring-input hover:text-foreground">
              <Icon name="plus" className="size-3" />
              <input type="color" aria-label="Custom colour" value={draft.color} onChange={(event) => patch({ color: event.target.value })} className="sr-only" />
            </label>
          </div>
        </div>

        {subagents.length > 0 && (
          <div className={LABEL}>
            Start from a subagent
            <Select
              soft
              title="Subagent"
              value={null}
              placeholder="Copy one's name, instructions and model"
              onChange={startFrom}
              options={subagents.map((subagent) => ({
                value: subagent.path,
                label: subagent.name,
                hint: SUBAGENT_SOURCES.find(([part]) => subagent.path.includes(part))?.[1],
                section: subagent.folder === window.api.home ? 'Yours' : subagent.folder
              }))}
            />
          </div>
        )}

        <label className={LABEL}>
          Instructions
          <textarea
            value={draft.instructions}
            onChange={(event) => patch({ instructions: event.target.value })}
            placeholder="What it does and how, e.g. You review diffs for bugs and explain each in one line."
            rows={5}
            className={PROMPT_FIELD}
          />
        </label>

        <div className="flex gap-2">
          <div className={`${LABEL} flex-1`}>
            Runs on
            <Select
              soft
              title="Runtime"
              value={runtimeChoice(draft.runtime)}
              onChange={(choice) => (patch({ runtime: fromChoice(choice), model: null, effort: null }), setOptions([]))}
              options={[
                ...(!spec && draft.runtime.kind === 'agent' ? [{ value: runtimeChoice(draft.runtime), label: `${draft.runtime.agent} (gone)`, section: 'Agents' }] : []),
                ...runtimes.map((entry) => ({ value: `agent:${entry.id}`, label: entry.label, section: 'Agents' })),
                ...API_PRESETS.map((preset) => ({ value: `api:${preset.baseUrl}`, label: preset.name, section: 'APIs' })),
                { value: CUSTOM_API, label: 'Other OpenAI-compatible API', section: 'APIs' }
              ]}
            />
          </div>
          <OptionField
            label="Model"
            optional={!isApi}
            loading={detecting}
            onOpen={detectOnOpen}
            value={draft.model}
            option={options.find((option) => option.category === 'model')}
            onChange={(model) => patch({ model })}
            action={
              <button
                onClick={() => detect(true)}
                disabled={!spec || (isApi && !URL.canParse(baseUrl)) || detecting}
                aria-label="Refresh models"
                title={isApi ? 'List the models the API offers again' : 'Start the runtime again to list its models'}
                className="grid size-4 place-items-center rounded-full hover:text-foreground disabled:opacity-40"
              >
                <Icon name={detecting ? 'loader' : 'refresh'} className={`size-3 ${detecting ? 'animate-spin' : ''}`} />
              </button>
            }
          />
          {(effortOption ?? draft.effort) && (
            <OptionField
              label="Effort"
              optional
              loading={detecting}
              onOpen={detectOnOpen}
              value={draft.effort ?? null}
              option={effortOption}
              onChange={(effort) => patch({ effort })}
            />
          )}
        </div>

        {isApi && (
          <div className="flex gap-2">
            {runtimeChoice(draft.runtime) === CUSTOM_API && (
              <label className={`${LABEL} flex-1`}>
                Base URL
                <input
                  value={baseUrl}
                  onChange={(event) => patch({ runtime: { kind: 'api', baseUrl: event.target.value.trim() } })}
                  placeholder="http://localhost:1234/v1"
                  className={`${FIELD} font-mono`}
                />
              </label>
            )}
            <label className={`${LABEL} flex-1`}>
              API key
              {keySaved ? (
                <span className="flex h-9 items-center gap-2 text-[13px] text-foreground">
                  Saved for {URL.canParse(baseUrl) ? new URL(baseUrl).host : baseUrl}
                  <button
                    onClick={() =>
                      void hubApi.setKey(baseUrl, null).then(
                        () => setKeySaved(false),
                        (reason: unknown) => setProblem(errorMessage(reason))
                      )
                    }
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    Remove
                  </button>
                </span>
              ) : (
                <input type="password" value={key} onChange={(event) => setKey(event.target.value)} placeholder="None for a local server" className={FIELD} />
              )}
            </label>
          </div>
        )}

        <div className="flex items-center gap-3 rounded-xl bg-foreground/5 px-3.5 py-3">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-[13px]">
            Works without asking
            <span className={`text-[11px] ${draft.autoApprove ? 'text-amber-500' : 'text-muted-foreground'}`}>
              {draft.autoApprove ? 'In workflow runs it edits files and runs commands without asking you first.' : 'In workflow runs it waits for you to allow what it asks.'}
            </span>
          </span>
          <Switch checked={draft.autoApprove === true} onChange={() => patch({ autoApprove: !draft.autoApprove })} label="Works without asking" />
        </div>

        <button onClick={() => setMore(!more)} aria-expanded={more} className="flex items-center gap-1.5 self-start text-xs text-muted-foreground hover:text-foreground">
          <Icon name="chevron" className={`size-3 ${more ? 'rotate-90' : ''}`} />
          Folder and schedules
        </button>
        {more && (
          <>
            <div className={LABEL}>
              Folder
              <FolderField value={draft.folder ?? ''} onChange={(folder) => patch({ folder: folder || null })} />
            </div>
            <Schedules schedules={draft.schedules ?? []} onChange={(schedules) => patch({ schedules })} />
          </>
        )}

        {problem && <span className="text-[11px] whitespace-pre-wrap text-red-400">{problem}</span>}
      </div>

      <div className={`flex shrink-0 justify-end ${inline ? 'pt-5' : 'border-t border-border px-6 py-4'}`}>
        <button onClick={save} disabled={!canSave} className="h-9 rounded-full bg-foreground px-5 text-[13px] font-medium text-on-foreground disabled:opacity-40">
          {agent ? 'Save' : 'Create bot'}
        </button>
      </div>
    </>
  )
  if (inline) return <div className="flex flex-col">{form}</div>
  return (
    <Dialog onClose={onClose} offset="pt-[8vh]" className="relative flex max-h-[84vh] w-[520px] max-w-[92vw] flex-col overflow-hidden rounded-3xl!">
      <button
        onClick={onClose}
        aria-label="Close"
        className="absolute top-3 right-3 z-10 grid size-8 place-items-center rounded-full bg-popover text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Icon name="close" className="size-3.5" />
      </button>
      {form}
    </Dialog>
  )
}

/** A whole number field that can be cleared and retyped: in-range values apply as typed, anything else settles in range on blur */
export function WholeNumber({
  value,
  min,
  max,
  onChange,
  className
}: {
  value: number
  min: number
  max: number
  onChange: (value: number) => void
  className: string
}): React.JSX.Element {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const parsed = (raw: string): number | null => (raw.trim() === '' || !Number.isFinite(Number(raw)) ? null : Math.round(Number(raw)))
  return (
    <input
      type="number"
      min={min}
      max={max}
      value={text}
      onChange={(event) => {
        setText(event.target.value)
        const typed = parsed(event.target.value)
        if (typed !== null && typed >= min && typed <= max && typed !== value) onChange(typed)
      }}
      onBlur={() => {
        const typed = parsed(text)
        const settled = typed === null ? value : Math.min(max, Math.max(min, typed))
        setText(String(settled))
        if (settled !== value) onChange(settled)
      }}
      className={className}
    />
  )
}
