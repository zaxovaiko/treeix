import { useEffect, useRef, useState } from 'react'
import { type ChatOption, useHost } from '@treeix/sdk'
import { useAgents } from '@treeix/app/agents'
import { Icon } from '@treeix/app/Icon'
import { Alien, characterOf, type Mood } from './Alien'
import { Select, type SelectOption } from '@treeix/app/Picker'
import { Dialog, errorMessage } from '@treeix/app/ui'
import { shrinkImage } from '@treeix/app/WorkspaceRail'
import { WORKSPACE_COLORS } from '@treeix/app/workspaces'
import { CRON_PRESETS, isCron } from '../shared/cron'
import { API_PRESETS, type HubAgent, MAX_TIMEOUT_MIN, type Runtime, type Schedule } from '../shared/types'
import { ASK_TIMEOUT_MIN } from '../shared/workflow'
import { useEscape } from './AskDialog'
import { hubApi, runtimeSpec } from './store'

const FIELD = 'h-8 rounded-md border border-input bg-muted px-2.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-primary'
const LABEL = 'flex min-w-0 flex-col gap-1.5 text-xs text-muted-foreground'

const CUSTOM_API = 'api:'

/** The runtime select's value: a registry agent, a named API, or any other API URL */
const runtimeChoice = (runtime: Runtime): string =>
  runtime.kind === 'agent' ? `agent:${runtime.agent}` : API_PRESETS.some((preset) => preset.baseUrl === runtime.baseUrl) ? `api:${runtime.baseUrl}` : CUSTOM_API

const fromChoice = (choice: string): Runtime =>
  choice.startsWith('agent:') ? { kind: 'agent', agent: choice.slice('agent:'.length) } : { kind: 'api', baseUrl: choice.slice('api:'.length) }

const glyphOf = (agent: Pick<HubAgent, 'icon' | 'name'>): string => agent.icon || agent.name.trim().slice(0, 1).toUpperCase() || '?'

/** The agent's uploaded image, else the alien of its runtime */
export function AgentAvatar({ agent, size, mood = 'idle' }: { agent: Pick<HubAgent, 'avatar' | 'runtime'>; size: number; mood?: Mood }): React.JSX.Element {
  return agent.avatar ? (
    <img src={agent.avatar} alt="" style={{ width: size, height: size }} className="shrink-0 rounded-lg object-cover" />
  ) : (
    <Alien character={characterOf(agent.runtime.kind === 'agent' ? agent.runtime.agent : undefined)} mood={mood} size={size} />
  )
}

const DEFAULT_CHOICE = ''

/** Picks one of the values the runtime offers, or any typed one; `optional` adds the runtime's own default */
function OptionField({
  label,
  value,
  option,
  optional,
  loading,
  onOpen,
  onChange
}: {
  label: string
  value: string | null
  option: ChatOption | undefined
  optional: boolean
  loading: boolean
  onOpen: () => void
  onChange: (value: string | null) => void
}): React.JSX.Element {
  const options: SelectOption[] = [
    ...(optional ? [{ value: DEFAULT_CHOICE, label: "The runtime's default" }] : []),
    ...(option?.values ?? []).map((entry) => ({ value: entry.value, label: entry.name, hint: entry.name === entry.value ? undefined : entry.value }))
  ]
  return (
    <div className={`${LABEL} flex-1`}>
      {label}
      <Select
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
  'resize-y rounded-md border border-input bg-muted px-2.5 py-2 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-primary'

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
        <div key={schedule.id} className="flex flex-col gap-2 rounded-md border border-border p-2.5">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <Select
                custom
                title="When, as a preset or a crontab line like 30 8 * * 1-5"
                value={schedule.cron}
                options={CRON_PRESETS.map((preset) => ({ value: preset.cron, label: preset.label, hint: preset.cron }))}
                onChange={(cron) => patch(schedule.id, { cron })}
              />
            </div>
            <label className="flex shrink-0 items-center gap-1.5 text-foreground">
              <input type="checkbox" checked={schedule.enabled} onChange={(event) => patch(schedule.id, { enabled: event.target.checked })} />
              On
            </label>
            <button
              onClick={() => onChange(schedules.filter((entry) => entry.id !== schedule.id))}
              aria-label="Remove schedule"
              className="grid size-7 shrink-0 place-items-center rounded-md hover:bg-accent hover:text-foreground"
            >
              <Icon name="trash" className="size-3.5" />
            </button>
          </div>
          {!isCron(schedule.cron) && <span className="text-[11px] text-destructive">Not a crontab line: minute hour day month weekday, e.g. 0 9 * * 1</span>}
          <textarea
            value={schedule.prompt}
            onChange={(event) => patch(schedule.id, { prompt: event.target.value })}
            placeholder={
              workflow
                ? 'The input each time; with a command, {{input}} is the line that started the run'
                : "What to do each time, e.g. Sum up this week's AI news in five bullets."
            }
            rows={2}
            className={PROMPT_FIELD}
          />
          <div className="flex gap-2">
            <label className={`${LABEL} flex-1`}>
              Command, optional
              <input
                value={schedule.command ?? ''}
                onChange={(event) => patch(schedule.id, { command: event.target.value })}
                placeholder="e.g. node poll.mjs: each line it prints starts a run, as {{input}}"
                className={`${FIELD} font-mono text-xs`}
              />
            </label>
            {/* A workflow's steps have their own timeouts */}
            {!workflow && (
              <label className={`${LABEL} w-24`}>
                Timeout, min
                <input
                  type="number"
                  min={1}
                  max={MAX_TIMEOUT_MIN}
                  value={schedule.timeoutMin ?? ASK_TIMEOUT_MIN}
                  onChange={(event) => patch(schedule.id, { timeoutMin: Math.min(MAX_TIMEOUT_MIN, Math.max(1, Math.round(Number(event.target.value)) || 1)) })}
                  className={FIELD}
                />
              </label>
            )}
          </div>
          <label className="flex items-center gap-1.5 text-foreground">
            <input type="checkbox" checked={schedule.notify} onChange={(event) => patch(schedule.id, { notify: event.target.checked })} />
            Show the answer as a notification
          </label>
        </div>
      ))}
    </div>
  )
}

export function AgentEditor({ agent, onClose, onSaved }: { agent: HubAgent | null; onClose: () => void; onSaved: (id: string) => void }): React.JSX.Element {
  const host = useHost()
  // Personas run on agents of the user's own, never on another plugin's
  const runtimes = useAgents().filter((entry) => entry.chat && !entry.plugin)
  const [draft, setDraft] = useState<HubAgent>(
    () =>
      agent ?? {
        id: crypto.randomUUID(),
        name: '',
        icon: '',
        avatar: null,
        color: WORKSPACE_COLORS[0],
        runtime: { kind: 'agent', agent: runtimes[0]?.id ?? 'claude' },
        model: null,
        mode: null,
        instructions: '',
        folder: null,
        updatedAt: 0
      }
  )
  const patch = (next: Partial<HubAgent>): void => setDraft((current) => ({ ...current, ...next }))
  const [options, setOptions] = useState<ChatOption[]>([])
  const [detecting, setDetecting] = useState(false)
  const [problem, setProblem] = useState('')
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

  useEscape(onClose)

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
      .finally(() => isPicked() && setDetecting(false))
  }
  const detectOnOpen = (): void => void (options.length === 0 && detect(false))

  const pickImage = (file: File | undefined): void => {
    if (!file) return
    shrinkImage(file).then(
      (avatar) => (patch({ avatar }), setProblem('')),
      () => setProblem(`${file.name} isn't an image`)
    )
  }

  const name = draft.name.trim()
  // An API has no default model to fall back on
  const canSave = name !== '' && (!isApi || (URL.canParse(baseUrl) && draft.model !== null)) && (draft.schedules ?? []).every((schedule) => isCron(schedule.cron))
  const save = (): void => {
    if (!canSave) return
    storeKey()
      .then(() => hubApi.save({ ...draft, name, icon: glyphOf(draft), mode: isApi ? null : draft.mode, updatedAt: Date.now() }))
      .then(
        () => onSaved(draft.id),
        (reason: unknown) => setProblem(errorMessage(reason))
      )
  }

  return (
    <Dialog onClose={onClose} offset="pt-[10vh]" className="flex max-h-[80vh] w-[560px] max-w-[92vw] flex-col">
      <div className="flex h-12 shrink-0 items-center border-b border-border pr-2 pl-4">
        <span className="text-sm font-medium">{agent ? `Edit ${agent.name}` : 'New agent'}</span>
        <button onClick={onClose} aria-label="Close" className="ml-auto grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent">
          <Icon name="close" className="size-3.5" />
        </button>
      </div>

      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4">
        <div className="flex items-end gap-3">
          <div className="flex shrink-0 flex-col items-center gap-1.5">
            <label title="Upload an image" className="cursor-pointer">
              <AgentAvatar agent={draft} size={44} />
              <input type="file" accept="image/*" aria-label="Avatar image" className="hidden" onChange={(event) => pickImage(event.target.files?.[0])} />
            </label>
            {draft.avatar ? (
              <button onClick={() => patch({ avatar: null })} className="h-6 text-[11px] text-muted-foreground hover:text-foreground">
                Remove
              </button>
            ) : (
              <input
                value={draft.icon}
                onChange={(event) => patch({ icon: [...event.target.value.trim()].slice(0, 2).join('') })}
                aria-label="Icon"
                placeholder={glyphOf({ ...draft, icon: '' })}
                className="h-6 w-11 rounded-md border border-input bg-muted text-center text-[11px] text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-primary"
              />
            )}
          </div>
          <label className={`${LABEL} flex-1`}>
            Name
            <input
              autoFocus
              value={draft.name}
              onChange={(event) => patch({ name: event.target.value })}
              onKeyDown={(event) => event.key === 'Enter' && save()}
              placeholder="Reviewer"
              className={FIELD}
            />
          </label>
          <div className={LABEL}>
            Colour
            <div className="flex h-8 items-center gap-1.5">
              {WORKSPACE_COLORS.map((swatch) => (
                <button
                  key={swatch}
                  aria-label={`Colour ${swatch}`}
                  onClick={() => patch({ color: swatch })}
                  style={{ background: swatch }}
                  className="grid size-5 place-items-center rounded-md text-white"
                >
                  {draft.color === swatch && <Icon name="check" className="size-3" />}
                </button>
              ))}
              <label title="Any colour" className="grid size-5 cursor-pointer place-items-center rounded-md text-muted-foreground ring-1 ring-border hover:text-foreground">
                <Icon name="plus" className="size-3" />
                <input type="color" aria-label="Custom colour" value={draft.color} onChange={(event) => patch({ color: event.target.value })} className="sr-only" />
              </label>
            </div>
          </div>
        </div>

        <div className="flex items-end gap-2">
          <div className={`${LABEL} flex-1`}>
            Runtime
            <Select
              title="Runtime"
              value={runtimeChoice(draft.runtime)}
              onChange={(choice) => (patch({ runtime: fromChoice(choice), model: null, mode: null }), setOptions([]))}
              options={[
                ...(!spec && draft.runtime.kind === 'agent' ? [{ value: runtimeChoice(draft.runtime), label: `${draft.runtime.agent} (gone)`, section: 'Agents' }] : []),
                ...runtimes.map((entry) => ({ value: `agent:${entry.id}`, label: entry.label, section: 'Agents' })),
                ...API_PRESETS.map((preset) => ({ value: `api:${preset.baseUrl}`, label: preset.name, section: 'APIs' })),
                { value: CUSTOM_API, label: 'Other OpenAI-compatible API', section: 'APIs' }
              ]}
            />
          </div>
          <button
            onClick={() => detect(true)}
            disabled={!spec || (isApi && !URL.canParse(baseUrl)) || detecting}
            title={isApi ? 'List the models the API offers' : 'Start the runtime once to list its models and modes'}
            className="h-8 rounded-md px-3 text-xs text-foreground ring-1 ring-border hover:bg-accent disabled:opacity-50"
          >
            {detecting ? 'Detecting…' : 'Refresh models'}
          </button>
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
                <span className="flex h-8 items-center gap-2 text-[13px] text-foreground">
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

        <div className="flex gap-2">
          <OptionField
            label="Model"
            optional={!isApi}
            loading={detecting}
            onOpen={detectOnOpen}
            value={draft.model}
            option={options.find((option) => option.category === 'model')}
            onChange={(model) => patch({ model })}
          />
          {!isApi && (
            <OptionField
              label="Mode"
              optional
              loading={detecting}
              onOpen={detectOnOpen}
              value={draft.mode}
              option={options.find((option) => option.category === 'mode')}
              onChange={(mode) => patch({ mode })}
            />
          )}
        </div>

        <label className={LABEL}>
          Instructions
          <textarea
            value={draft.instructions}
            onChange={(event) => patch({ instructions: event.target.value })}
            placeholder="Who the agent is and how it works, e.g. You review diffs for bugs and explain each in one line."
            rows={6}
            className={PROMPT_FIELD}
          />
        </label>

        <label className={LABEL}>
          Folder
          <input
            value={draft.folder ?? ''}
            onChange={(event) => patch({ folder: event.target.value.trim() || null })}
            placeholder="The selected worktree"
            className={`${FIELD} font-mono`}
          />
        </label>

        <label className="flex items-start gap-2 text-xs">
          <input type="checkbox" checked={draft.autoApprove === true} onChange={(event) => patch({ autoApprove: event.target.checked })} className="mt-0.5 shrink-0" />
          <span>
            Allow everything it asks in workflow runs
            {draft.autoApprove && <span className="mt-0.5 block text-[11px] text-amber-400">It edits files and runs commands without asking you first.</span>}
          </span>
        </label>

        <Schedules schedules={draft.schedules ?? []} onChange={(schedules) => patch({ schedules })} />

        {problem && <span className="text-[11px] whitespace-pre-wrap text-destructive">{problem}</span>}
      </div>

      <div className="flex shrink-0 justify-end gap-2 border-t border-border px-4 py-3">
        <button onClick={onClose} className="h-7 rounded-md px-3 text-xs text-muted-foreground hover:bg-accent">
          Cancel
        </button>
        <button onClick={save} disabled={!canSave} className="h-7 rounded-md bg-primary px-3 text-xs font-medium text-white disabled:opacity-50">
          {agent ? 'Save' : 'Create'}
        </button>
      </div>
    </Dialog>
  )
}
