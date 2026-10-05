import { useEffect, useState } from 'react'
import { Select } from '@treeix/app/Picker'
import { Card, Row, Segmented, Switch } from '@treeix/app/settingsUi'
import { CopyButton } from '@treeix/app/ui'
import { DEFAULT_PROMPT, HOTKEYS, type Hotkey, MODELS, type ModelId, type ModelState, type Permissions, type Status } from '../shared/types'
import { bridge, dictationSettings, history, status } from './state'

const field = 'h-7 rounded-md bg-muted px-2 text-xs ring-1 ring-border outline-none focus:ring-primary'
const button = 'h-7 rounded-md border border-border px-2.5 text-xs hover:bg-accent disabled:opacity-50'

const HELPER_PROBLEMS: Partial<Record<Status['helper'], string>> = {
  unsupported: 'Dictation needs an Apple silicon Mac on macOS 14 or later.',
  missing: 'The dictation helper is not built. Run `bun run build:voice` in apps/desktop and restart Treeix.',
  crashed: 'The dictation helper stopped and is restarting.'
}

/** Permissions change in System Settings, so they're read again while this page is open */
function usePermissions(): [Permissions | null, (next: Permissions) => void] {
  const [permissions, setPermissions] = useState<Permissions | null>(null)
  useEffect(() => {
    const read = (): void => void bridge.invoke<Permissions>('permissions').then(setPermissions)
    read()
    const timer = setInterval(read, 2000)
    return () => clearInterval(timer)
  }, [])
  return [permissions, setPermissions]
}

function Setup({ current }: { current: Status | null }): React.JSX.Element {
  const [permissions, setPermissions] = usePermissions()
  const problem = current && HELPER_PROBLEMS[current.helper]
  return (
    <Card title="Setup">
      {problem && (
        <Row label="Helper" description={problem}>
          <span className="text-xs text-amber-400">{current.helper === 'crashed' ? 'Restarting' : 'Unavailable'}</span>
        </Row>
      )}
      <Row label="Microphone" description="Treeix listens only while the key is held, or until the second tap.">
        {permissions?.microphone === 'granted' ? (
          <span className="text-xs text-emerald-400">Allowed</span>
        ) : (
          <button className={button} onClick={() => void bridge.invoke<Permissions>('requestMicrophone').then(setPermissions)}>
            {permissions?.microphone === 'not-determined' ? 'Allow' : 'Open System Settings'}
          </button>
        )}
      </Row>
      <Row label="Accessibility" description="Lets Treeix notice the key in other apps and paste the text into them. Turn Treeix on in the list that opens.">
        {permissions?.accessibility ? (
          <span className="text-xs text-emerald-400">Allowed</span>
        ) : (
          <button className={button} onClick={() => void bridge.invoke<Permissions>('requestAccessibility').then(setPermissions)}>
            Open System Settings
          </button>
        )}
      </Row>
      {current?.error && (
        <Row label="Last problem" description={current.error}>
          <span />
        </Row>
      )}
    </Card>
  )
}

function Shortcut(): React.JSX.Element {
  const { hotkey, tapToToggle, sounds } = dictationSettings.use()
  return (
    <Card title="Shortcut">
      <Row label="Key" description="Hold it and speak; release to paste. Pressing it together with another key, or Esc, cancels.">
        <Segmented<Hotkey> value={hotkey} options={Object.entries(HOTKEYS) as [Hotkey, string][]} onChange={(next) => dictationSettings.update({ hotkey: next })} />
      </Row>
      <Row label="Tap for hands-free" description="A quick tap keeps listening until you tap again.">
        <Switch checked={tapToToggle} label="Tap for hands-free" onChange={() => dictationSettings.update({ tapToToggle: !tapToToggle })} />
      </Row>
      <Row label="Sounds" description="A click when listening starts and stops.">
        <Switch checked={sounds} label="Sounds" onChange={() => dictationSettings.update({ sounds: !sounds })} />
      </Row>
    </Card>
  )
}

function ModelControls({ id, state, selected }: { id: ModelId; state: ModelState | undefined; selected: boolean }): React.JSX.Element {
  if (!state) return <span className="text-xs text-muted-foreground">…</span>
  const download = (
    <button
      className={button}
      onClick={() => {
        dictationSettings.update({ model: id })
        void bridge.invoke('download', id)
      }}
    >
      {state.state === 'error' ? 'Retry' : 'Download'}
    </button>
  )
  if (state.state === 'missing' || state.state === 'error') return download
  if (state.state === 'downloading') return <span className="text-xs text-muted-foreground tabular-nums">Downloading {Math.round((state.progress ?? 0) * 100)}%</span>
  return (
    <div className="flex items-center gap-2">
      {selected ? (
        <span className="text-xs text-emerald-400">{state.state === 'loading' ? 'Loading…' : 'In use'}</span>
      ) : (
        <button className={button} onClick={() => dictationSettings.update({ model: id })}>
          Use
        </button>
      )}
      <button className={button} disabled={state.state === 'loading'} onClick={() => void bridge.invoke('delete', id)}>
        Delete
      </button>
    </div>
  )
}

function Models({ current }: { current: Status | null }): React.JSX.Element {
  const { model } = dictationSettings.use()
  return (
    <Card title="Speech model">
      {(Object.keys(MODELS) as ModelId[]).map((id) => {
        const state = current?.models.find((entry) => entry.id === id)
        return (
          <Row key={id} label={MODELS[id].name} description={state?.error ?? MODELS[id].description}>
            <ModelControls id={id} state={state} selected={id === model} />
          </Row>
        )
      })}
    </Card>
  )
}

function Formatting(): React.JSX.Element {
  const { formatting } = dictationSettings.use()
  const [models, setModels] = useState<string[] | null>(null)
  const update = (patch: Partial<typeof formatting>): void => dictationSettings.update({ formatting: { ...formatting, ...patch } })
  const loadModels = (): void => {
    setModels(null)
    void bridge.invoke<string[]>('formatterModels', formatting.baseUrl).then(setModels)
  }
  return (
    <Card title="Formatting">
      <Row
        label="Tidy up with a local model"
        description="Fixes punctuation and drops filler words through Ollama, LM Studio or any OpenAI-compatible server. If it's slow or fails, the raw text is pasted."
      >
        <Switch checked={formatting.enabled} label="Tidy up with a local model" onChange={() => update({ enabled: !formatting.enabled })} />
      </Row>
      {formatting.enabled && (
        <>
          <Row label="Server" description="OpenAI-compatible base URL. Ollama: http://localhost:11434/v1, LM Studio: http://localhost:1234/v1.">
            <input
              value={formatting.baseUrl}
              aria-label="Server"
              spellCheck={false}
              onChange={(event) => update({ baseUrl: event.target.value })}
              className={`${field} w-64 font-mono`}
            />
          </Row>
          <Row label="Model" description="A small, fast model is enough, e.g. qwen3:4b or gemma3:4b.">
            <Select
              title="Model"
              value={formatting.model || null}
              custom
              width="w-64"
              onOpen={loadModels}
              note={models === null ? 'Loading…' : models.length === 0 ? 'No models found at this URL; type a name' : undefined}
              options={(models ?? []).map((name) => ({ value: name, label: name }))}
              onChange={(name) => update({ model: name })}
            />
          </Row>
          <Row label="Instructions" description="What the model is told before your text. Terms from the vocabulary are added to it.">
            <div className="flex w-96 max-w-full flex-col items-end gap-1.5">
              <textarea
                value={formatting.prompt}
                aria-label="Instructions"
                rows={5}
                onChange={(event) => update({ prompt: event.target.value })}
                className={`${field} h-auto w-full py-1.5`}
              />
              {formatting.prompt !== DEFAULT_PROMPT && (
                <button className={button} onClick={() => update({ prompt: DEFAULT_PROMPT })}>
                  Reset
                </button>
              )}
            </div>
          </Row>
        </>
      )}
    </Card>
  )
}

function Vocabulary(): React.JSX.Element {
  const { vocabulary } = dictationSettings.use()
  const [term, setTerm] = useState('')
  const [aliases, setAliases] = useState('')
  const add = (): void => {
    if (!term.trim()) return
    const next = {
      text: term.trim(),
      aliases: aliases
        .split(',')
        .map((alias) => alias.trim())
        .filter(Boolean)
    }
    dictationSettings.update({ vocabulary: [...vocabulary.filter((entry) => entry.text !== next.text), next] })
    setTerm('')
    setAliases('')
  }
  return (
    <Card title="Vocabulary">
      {vocabulary.map((entry) => (
        <Row key={entry.text} label={entry.text} description={entry.aliases.length > 0 ? `Replaces ${entry.aliases.join(', ')}` : 'Spelled as written'}>
          <button className={button} onClick={() => dictationSettings.update({ vocabulary: vocabulary.filter((other) => other !== entry) })}>
            Remove
          </button>
        </Row>
      ))}
      <Row label="Add a term" description="Names and jargon the model gets wrong. Aliases are what it hears instead, comma-separated.">
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            add()
          }}
        >
          <input value={term} placeholder="Treeix" aria-label="Term" onChange={(event) => setTerm(event.target.value)} className={`${field} w-32`} />
          <input value={aliases} placeholder="tricks, трікс" aria-label="Aliases" onChange={(event) => setAliases(event.target.value)} className={`${field} w-48`} />
          <button type="submit" className={button}>
            Add
          </button>
        </form>
      </Row>
    </Card>
  )
}

function History(): React.JSX.Element {
  const items = history.use()
  return (
    <Card title="History">
      {items.length === 0 ? (
        <Row label="Nothing yet" description="The last 50 dictations show here, stored only on this Mac.">
          <span />
        </Row>
      ) : (
        <>
          {items.map((item) => (
            <Row
              key={item.at}
              label={item.text}
              description={`${new Date(item.at).toLocaleString()}${item.app ? ` in ${item.app}` : ''}${item.raw !== item.text ? `. Heard: ${item.raw}` : ''}`}
            >
              <CopyButton text={() => item.text} />
            </Row>
          ))}
          <Row label="Clear history" description="Removes every dictation stored on this Mac.">
            <button className={button} onClick={() => void bridge.invoke('clearHistory')}>
              Clear
            </button>
          </Row>
        </>
      )}
    </Card>
  )
}

export function DictationSettings(): React.JSX.Element {
  const current = status.use()
  return (
    <>
      <Setup current={current} />
      <Shortcut />
      <Models current={current} />
      <Formatting />
      <Vocabulary />
      <History />
    </>
  )
}
