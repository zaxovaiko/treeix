import { useEffect, useState } from 'react'
import { Card, Row, Segmented, Switch } from '@treeix/app/settingsUi'
import { DEFAULT_RULES, LANGUAGES, type Permissions, type Rule, START_DELAYS, STOP_DELAYS, type Status } from '../shared/types'
import { bridge, button, meetingsSettings, status } from './state'

const field = 'h-7 min-w-0 rounded-md bg-muted px-2 text-xs ring-1 ring-border outline-none focus:ring-primary'

const HELPER_PROBLEMS: Partial<Record<Status['helper'], string>> = {
  unsupported: 'Recording needs an Apple silicon Mac on macOS 14 or later.',
  missing: 'The meetings helper is not built. Run `bun run build:voice` in apps/desktop and restart Treeix.',
  crashed: 'The meetings helper stopped and is restarting.'
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

const Allowed = (): React.JSX.Element => <span className="text-xs text-emerald-400">Allowed</span>
const OpenPane = ({ pane }: { pane: string }): React.JSX.Element => (
  <button className={button} onClick={() => void bridge.invoke('openPane', pane)}>
    Open System Settings
  </button>
)

function Setup(): React.JSX.Element {
  const current = status.use()
  const [permissions, setPermissions] = usePermissions()
  const problem = current && HELPER_PROBLEMS[current.helper]
  return (
    <Card title="Setup">
      {problem && (
        <Row label="Helper" description={problem}>
          <span className="text-xs text-amber-400">{current.helper === 'crashed' ? 'Restarting' : 'Unavailable'}</span>
        </Row>
      )}
      <Row label="Microphone" description="Records you, and anyone in the room with you.">
        {permissions?.microphone === 'granted' ? (
          <Allowed />
        ) : (
          <button className={button} onClick={() => void bridge.invoke<Permissions>('requestMicrophone').then(setPermissions)}>
            {permissions?.microphone === 'not-determined' ? 'Allow' : 'Open System Settings'}
          </button>
        )}
      </Row>
      <Row label="System audio" description="Records what the call app plays, the other participants. macOS asks the first time a call is recorded.">
        <OpenPane pane="System audio" />
      </Row>
      <Row label="Calendar" description="Names meetings after their calendar event and lists the invitees. Google calendars count once added to the macOS Calendar app.">
        {permissions?.calendar === 'granted' ? (
          <Allowed />
        ) : (
          <button className={button} onClick={() => void bridge.invoke<Permissions>('requestCalendar').then(setPermissions)}>
            Allow
          </button>
        )}
      </Row>
      <Row label="Speech models" description="Parakeet v3 and the speaker models, about 480 MB, download with the first transcript into the folder dictation uses.">
        <span />
      </Row>
      <Row label="Google Chrome" description="Rules with a URL read Chrome's tabs while Chrome uses the microphone. macOS asks the first time; it's under Automation.">
        <OpenPane pane="Automation" />
      </Row>
      {current?.error && (
        <Row label="Last problem" description={current.error}>
          <span />
        </Row>
      )}
    </Card>
  )
}

/** Each meeting keeps its audio as meeting.m4a, so it can be transcribed again; this deletes them all */
function AudioRow(): React.JSX.Element {
  const [size, setSize] = useState<number | null>(null)
  const read = (): void => void bridge.invoke<number>('audioSize').then(setSize)
  useEffect(read, [])
  const remove = (): void => {
    if (window.confirm('Delete the audio of every meeting? Transcripts and notes stay, but meetings can no longer be transcribed again.'))
      void bridge.invoke('removeAudio').then(read)
  }
  return (
    <Row label="Audio" description={`Kept next to each transcript, so a meeting can be transcribed again.${size ? ` ${Math.round(size / 1e6)} MB now.` : ''}`}>
      <button className={button} disabled={!size} onClick={remove}>
        Delete audio
      </button>
    </Row>
  )
}

function Recording(): React.JSX.Element {
  const { auto, startDelaySec, stopDelaySec, calendar, language, folder } = meetingsSettings.use()
  return (
    <Card title="Recording">
      <Row label="Record calls on their own" description="When a rule below matches. Off, only the Start recording command records.">
        <Switch checked={auto} label="Record calls on their own" onChange={() => meetingsSettings.update({ auto: !auto })} />
      </Row>
      <Row label="Start after" description="Seconds a call has to last before recording starts.">
        <Segmented
          value={`${startDelaySec}`}
          options={START_DELAYS.map((seconds) => [`${seconds}`, `${seconds}s`])}
          onChange={(next) => meetingsSettings.update({ startDelaySec: START_DELAYS.find((seconds) => `${seconds}` === next) ?? 3 })}
        />
      </Row>
      <Row label="Stop after" description="Seconds after the call app lets go of the microphone. Apps keep it while you're muted.">
        <Segmented
          value={`${stopDelaySec}`}
          options={STOP_DELAYS.map((seconds) => [`${seconds}`, `${seconds}s`])}
          onChange={(next) => meetingsSettings.update({ stopDelaySec: STOP_DELAYS.find((seconds) => `${seconds}` === next) ?? 20 })}
        />
      </Row>
      <Row label="Use the calendar" description="Titles and invitees from the event the call falls in, and today's calls in the Meetings tab.">
        <Switch checked={calendar} label="Use the calendar" onChange={() => meetingsSettings.update({ calendar: !calendar })} />
      </Row>
      <Row
        label="Language"
        description="What your calls are spoken in. Picking it stops words in the wrong alphabet, such as Cyrillic in a Polish call. Detect suits calls that mix languages."
      >
        <select
          aria-label="Language"
          value={language}
          onChange={(event) => meetingsSettings.update({ language: LANGUAGES.find(([code]) => code === event.target.value)?.[0] ?? '' })}
          className="h-7 rounded-md border border-border bg-background px-2 text-xs"
        >
          {LANGUAGES.map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
      </Row>
      <AudioRow />
      <Row label="Folder" description="Where each meeting gets a folder. Empty keeps them in Treeix's app data.">
        <input
          aria-label="Folder"
          value={folder}
          placeholder="App data"
          onChange={(event) => meetingsSettings.update({ folder: event.target.value.trim() })}
          className={`${field} w-56`}
        />
      </Row>
    </Card>
  )
}

function Rules(): React.JSX.Element {
  const { rules } = meetingsSettings.use()
  const change = (index: number, patch: Partial<Rule>): void => meetingsSettings.update({ rules: rules.map((rule, at) => (at === index ? { ...rule, ...patch } : rule)) })
  return (
    <Card title="Calls">
      <p className="mb-2 px-2 text-[11px] text-muted-foreground">
        A call is on while an app whose bundle id starts with App uses the microphone; with a URL, a Chrome tab's address must also match it as a regular expression.
      </p>
      {rules.map((rule, index) => (
        <div key={index} className="flex items-center gap-1.5 px-2 py-1">
          <input aria-label="Name" value={rule.name} placeholder="Name" onChange={(event) => change(index, { name: event.target.value })} className={`${field} w-32`} />
          <input
            aria-label="App"
            value={rule.app}
            placeholder="Bundle id"
            onChange={(event) => change(index, { app: event.target.value.trim() })}
            className={`${field} w-44 font-mono`}
          />
          <input
            aria-label="URL"
            value={rule.url}
            placeholder="Any tab"
            onChange={(event) => change(index, { url: event.target.value.trim() })}
            className={`${field} flex-1 font-mono`}
          />
          <button className={button} onClick={() => meetingsSettings.update({ rules: rules.filter((_, at) => at !== index) })}>
            Remove
          </button>
        </div>
      ))}
      <div className="flex gap-2 px-2 pt-2">
        <button className={button} onClick={() => meetingsSettings.update({ rules: [...rules, { name: '', app: '', url: '' }] })}>
          Add call
        </button>
        <button className={button} onClick={() => meetingsSettings.update({ rules: DEFAULT_RULES })}>
          Reset to defaults
        </button>
      </div>
    </Card>
  )
}

export function MeetingsSettings(): React.JSX.Element {
  return (
    <>
      <Setup />
      <Recording />
      <Rules />
      <Card title="Workflows">
        <p className="px-2 text-[11px] text-muted-foreground">
          Each transcript starts the AI Hub workflows listening for meetings.transcribed, with id, title, date, start, end, app, url, invitees, folder and transcript. They can save
          notes back with the meetings_save_notes tool.
        </p>
      </Card>
    </>
  )
}
