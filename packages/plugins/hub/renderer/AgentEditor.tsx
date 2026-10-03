import { useEffect, useState } from 'react'
import { type ChatOption, useHost } from '@treeix/sdk'
import { useAgents } from '@treeix/app/agents'
import { Icon } from '@treeix/app/Icon'
import { Dialog, errorMessage } from '@treeix/app/ui'
import { shrinkImage } from '@treeix/app/WorkspaceRail'
import { WORKSPACE_COLORS } from '@treeix/app/workspaces'
import { API_PRESETS, type HubAgent, type Runtime } from '../shared/types'
import { useEscape } from './AskDialog'
import { hubApi, runtimeSpec } from './store'

const FIELD = 'h-8 rounded-md border border-input bg-muted px-2.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/60'
const LABEL = 'flex min-w-0 flex-col gap-1.5 text-xs text-muted-foreground'

const CUSTOM_API = 'api:'

/** The runtime select's value: a registry agent, a named API, or any other API URL */
const runtimeChoice = (runtime: Runtime): string =>
  runtime.kind === 'agent' ? `agent:${runtime.agent}` : API_PRESETS.some((preset) => preset.baseUrl === runtime.baseUrl) ? `api:${runtime.baseUrl}` : CUSTOM_API

const fromChoice = (choice: string): Runtime =>
  choice.startsWith('agent:') ? { kind: 'agent', agent: choice.slice('agent:'.length) } : { kind: 'api', baseUrl: choice.slice('api:'.length) }

const glyphOf = (agent: Pick<HubAgent, 'icon' | 'name'>): string => agent.icon || agent.name.trim().slice(0, 1).toUpperCase() || '?'

export function AgentAvatar({ agent, className }: { agent: Pick<HubAgent, 'avatar' | 'icon' | 'name' | 'color'>; className: string }): React.JSX.Element {
  return agent.avatar ? (
    <img src={agent.avatar} alt="" className={`shrink-0 rounded-lg object-cover ${className}`} />
  ) : (
    <span style={{ background: agent.color }} className={`grid shrink-0 place-items-center rounded-lg font-semibold text-white ${className}`}>
      {glyphOf(agent)}
    </span>
  )
}

/** A text field that suggests the values the runtime offers and takes any other */
function OptionField({
  label,
  value,
  option,
  placeholder,
  onChange
}: {
  label: string
  value: string | null
  option: ChatOption | undefined
  placeholder: string
  onChange: (value: string | null) => void
}): React.JSX.Element {
  const listId = `hub-${label.toLowerCase()}s`
  return (
    <label className={`${LABEL} flex-1`}>
      {label}
      <input list={listId} value={value ?? ''} onChange={(event) => onChange(event.target.value.trim() || null)} placeholder={placeholder} className={FIELD} />
      <datalist id={listId}>
        {option?.values.map((entry) => (
          <option key={entry.value} value={entry.value}>
            {entry.name}
          </option>
        ))}
      </datalist>
    </label>
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
    void hubApi.hasKey(baseUrl).then((saved) => current && setKeySaved(saved), () => undefined)
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

  const detect = (): void => {
    if (!spec) return
    setDetecting(true)
    setProblem('')
    storeKey()
      .then(() => hubApi.detect(spec, draft.folder ?? host.defaultCwd))
      .then(
        (found) => (setOptions(found), found.length === 0 && setProblem('The runtime lists no models; type one in')),
        (reason: unknown) => setProblem(errorMessage(reason))
      )
      .finally(() => setDetecting(false))
  }

  const pickImage = (file: File | undefined): void => {
    if (!file) return
    shrinkImage(file).then(
      (avatar) => (patch({ avatar }), setProblem('')),
      () => setProblem(`${file.name} isn't an image`)
    )
  }

  const name = draft.name.trim()
  // An API has no default model to fall back on
  const canSave = name !== '' && (!isApi || (URL.canParse(baseUrl) && draft.model !== null))
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
              <AgentAvatar agent={draft} className="size-11 text-base" />
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
                className="h-6 w-11 rounded-md border border-input bg-muted text-center text-[11px] text-foreground outline-none placeholder:text-muted-foreground/60"
              />
            )}
          </div>
          <label className={`${LABEL} flex-1`}>
            Name
            <input autoFocus value={draft.name} onChange={(event) => patch({ name: event.target.value })} onKeyDown={(event) => event.key === 'Enter' && save()} placeholder="Reviewer" className={FIELD} />
          </label>
          <div className={LABEL}>
            Colour
            <div className="flex h-8 items-center gap-1.5">
              {WORKSPACE_COLORS.map((swatch) => (
                <button key={swatch} aria-label={`Colour ${swatch}`} onClick={() => patch({ color: swatch })} style={{ background: swatch }} className="grid size-5 place-items-center rounded-md text-white">
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
          <label className={`${LABEL} flex-1`}>
            Runtime
            <select
              value={runtimeChoice(draft.runtime)}
              onChange={(event) => (patch({ runtime: fromChoice(event.target.value), model: null, mode: null }), setOptions([]))}
              className={FIELD}
            >
              {!spec && draft.runtime.kind === 'agent' && <option value={runtimeChoice(draft.runtime)}>{draft.runtime.agent} (gone)</option>}
              <optgroup label="Agents">
                {runtimes.map((entry) => (
                  <option key={entry.id} value={`agent:${entry.id}`}>
                    {entry.label}
                  </option>
                ))}
              </optgroup>
              <optgroup label="APIs">
                {API_PRESETS.map((preset) => (
                  <option key={preset.baseUrl} value={`api:${preset.baseUrl}`}>
                    {preset.name}
                  </option>
                ))}
                <option value={CUSTOM_API}>Other OpenAI-compatible API</option>
              </optgroup>
            </select>
          </label>
          <button
            onClick={detect}
            disabled={!spec || (isApi && !URL.canParse(baseUrl)) || detecting}
            title={isApi ? 'List the models the API offers' : 'Start the runtime once to list its models and modes'}
            className="h-8 rounded-md px-3 text-xs text-foreground ring-1 ring-border hover:bg-accent disabled:opacity-50"
          >
            {detecting ? 'Detecting…' : 'Detect models'}
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
                    onClick={() => void hubApi.setKey(baseUrl, null).then(() => setKeySaved(false), (reason: unknown) => setProblem(errorMessage(reason)))}
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
          <OptionField label="Model" placeholder={isApi ? 'Required' : "The runtime's default"} value={draft.model} option={options.find((option) => option.category === 'model')} onChange={(model) => patch({ model })} />
          {!isApi && <OptionField label="Mode" placeholder="The runtime's default" value={draft.mode} option={options.find((option) => option.category === 'mode')} onChange={(mode) => patch({ mode })} />}
        </div>

        <label className={LABEL}>
          Instructions
          <textarea
            value={draft.instructions}
            onChange={(event) => patch({ instructions: event.target.value })}
            placeholder="Who the agent is and how it works, e.g. You review diffs for bugs and explain each in one line."
            rows={6}
            className="resize-y rounded-md border border-input bg-muted px-2.5 py-2 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/60"
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
