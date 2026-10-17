import { useEffect, useState } from 'react'
import { Card, Row, Steps, Switch } from '@treeix/app/settingsUi'
import { errorMessage } from '@treeix/app/ui'
import { fit, LOCAL_MODELS, type LocalModelsState, longContextId } from '../shared/catalog'
import { DECISION_DEFAULTS, type DecisionSettings, type RemoteStatus } from '../shared/types'
import { hubApi } from './store'

const button = 'h-7 rounded-md border border-border px-2.5 text-xs hover:bg-accent disabled:opacity-50'
const FIT_COLOR = { fits: 'text-emerald-400', tight: 'text-amber-400', 'too big': 'text-red-400' } as const

/** What a model is doing, or why its last action failed */
type Job = { label: string; failed: boolean }

export function HubSettings(): React.JSX.Element {
  return (
    <>
      <RunsCard />
      <AwayCard />
      <RemoteCard />
      <LocalModels />
    </>
  )
}

function RunsCard(): React.JSX.Element {
  const [autoResume, setAutoResume] = useState(false)
  useEffect(() => void hubApi.autoResume().then(setAutoResume), [])
  const toggle = (): void => {
    const next = !autoResume
    setAutoResume(next)
    void hubApi.setAutoResume(next)
  }
  return (
    <Card title="Runs">
      <Row
        label="Resume interrupted runs on launch"
        description="Workflow runs cut off by quitting Treeix pick up where they stopped when it opens again, continuing the agent sessions of their unfinished steps."
      >
        <Switch checked={autoResume} label="Resume interrupted runs on launch" onChange={toggle} />
      </Row>
    </Card>
  )
}

/** Who answers a step waiting on the user when nobody does */
function AwayCard(): React.JSX.Element {
  const [settings, setSettings] = useState<DecisionSettings | null>(null)
  useEffect(() => void hubApi.decisionSettings().then(setSettings), [])
  const change = (next: Partial<DecisionSettings>): void => {
    if (!settings) return
    setSettings({ ...settings, ...next })
    void hubApi.setDecisionSettings({ ...settings, ...next })
  }
  return (
    <Card title="When you're away">
      <Row
        label="Let an agent decide"
        description="When a step waits for your approval or an agent asks for permission and nobody answers within an hour, the step's agent decides. Its reason shows on the run, your phone and the ticket."
      >
        <Switch
          checked={settings?.afterMin !== null}
          label="Let an agent decide"
          onChange={() => change({ afterMin: settings?.afterMin === null ? DECISION_DEFAULTS.afterMin : null })}
        />
      </Row>
      <Row
        label="Ask on the ticket"
        description='Runs started from a Jira work item or Notion page also ask in a comment there when you are away, and take a reply starting with "approve" or "reject".'
      >
        <Switch checked={settings?.ticket ?? true} label="Ask on the ticket" onChange={() => change({ ticket: !(settings?.ticket ?? true) })} />
      </Row>
    </Card>
  )
}

/** The web app the phone opens over Tailscale, and the devices it notifies */
function RemoteCard(): React.JSX.Element {
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => {
    void hubApi.remote().then(setStatus)
    return hubApi.onRemote(setStatus)
  }, [])
  const report = (promise: Promise<unknown>): void => void promise.catch((reason: unknown) => setNote(errorMessage(reason)))
  const test = (): void => report(hubApi.testPush().then((reached) => setNote(reached ? `Sent to ${reached} device${reached === 1 ? '' : 's'}` : 'No device got it')))
  return (
    <Card title="Remote access">
      <Row
        label="Open Agents from your phone"
        description="Puts a web app on your Tailscale network, for you only: see what runs, approve steps, answer agents and start workflows from any of your devices. Treeix and this Mac must stay on."
      >
        <Switch checked={status?.on ?? false} label="Open Agents from your phone" onChange={() => status && report(hubApi.setRemote(!status.on))} />
      </Row>
      {status?.on && (
        <Row
          label={status.url ? 'Address' : status.enableUrl ? 'Waiting for Serve' : 'Starting'}
          description={
            status.error ??
            (status.enableUrl
              ? 'Your tailnet has Serve turned off. Turn it on (and HTTPS when asked), and this finishes on its own.'
              : status.url
                ? 'Open it on your phone with Tailscale on, then Share, Add to Home Screen, and turn on notifications there.'
                : 'Putting the web app on your tailnet…')
          }
        >
          {status.enableUrl ? (
            <a href={status.enableUrl} target="_blank" rel="noreferrer" className={button}>
              Turn on Serve
            </a>
          ) : (
            status.url && (
              <a href={status.url} target="_blank" rel="noreferrer" className="text-xs text-primary select-text hover:underline">
                {status.url}
              </a>
            )
          )}
        </Row>
      )}
      <Row
        label="Notified devices"
        description={note ?? `${status?.devices ?? 0} device${status?.devices === 1 ? '' : 's'} get a notification when a run needs you, fails or finishes while you're away.`}
      >
        <div className="flex gap-2">
          <button onClick={test} disabled={!status?.devices} className={button}>
            Send a test
          </button>
          <button onClick={() => report(hubApi.forgetDevices())} disabled={!status?.devices} className={button}>
            Forget all
          </button>
        </div>
      </Row>
    </Card>
  )
}

const ModelSteps = ({ quality, speed }: { quality: number; speed: number }): React.JSX.Element => (
  <span className="mr-2 flex flex-col gap-1">
    <Steps label="Quality" value={quality} />
    <Steps label="Speed" value={speed} />
  </span>
)

/** Ollama models with ratings and whether they fit this Mac; agents and workflows pick them under the Ollama API */
function LocalModels(): React.JSX.Element {
  const [local, setLocal] = useState<LocalModelsState | undefined>(undefined)
  const [jobs, setJobs] = useState<Record<string, Job>>({})
  const setJob = (id: string, job: Job | null): void =>
    setJobs((current) => {
      const next = { ...current }
      if (job) next[id] = job
      else delete next[id]
      return next
    })
  const refresh = (): void => void hubApi.localModels().then(setLocal)
  useEffect(refresh, [])
  useEffect(() => hubApi.onPull((id, percent) => setJob(id, { label: `${percent}%`, failed: false })), [])

  const run = (id: string, label: string, action: (id: string) => Promise<void>): void => {
    setJob(id, { label, failed: false })
    action(id).then(
      () => (setJob(id, null), refresh()),
      (error: unknown) => setJob(id, { label: errorMessage(error), failed: true })
    )
  }

  if (local === undefined) return <Card title="Local models">{null}</Card>
  if (local === null)
    return (
      <Card title="Local models">
        <Row label="Ollama isn't running" description="Install it from ollama.com and open it, then come back here to download models.">
          <button className={button} onClick={refresh}>
            Check again
          </button>
        </Row>
      </Card>
    )
  return (
    <Card title="Local models">
      {LOCAL_MODELS.map((model) => {
        const installed = local.installed.includes(model.id)
        const long = local.installed.includes(longContextId(model.id))
        const rating = fit(model.sizeGB, local.totalGB)
        const job = jobs[model.id]
        return (
          <Row
            key={model.id}
            label={model.name}
            description={job?.failed ? job.label : `${model.note} ${model.sizeGB} GB. ${long ? `Long context: ${longContextId(model.id)}.` : model.id}`}
          >
            <div className="flex items-center gap-2">
              <ModelSteps quality={model.quality} speed={model.speed} />
              <span className={`text-xs ${FIT_COLOR[rating]}`}>{rating}</span>
              {job && !job.failed ? (
                <>
                  <span className="text-xs text-muted-foreground">{job.label}</span>
                  {!installed && (
                    <button className={button} onClick={() => void hubApi.cancelPull(model.id)}>
                      Cancel
                    </button>
                  )}
                </>
              ) : installed ? (
                <>
                  {!long && (
                    <button
                      className={button}
                      title="Adds a variant that reads 64k tokens, so long transcripts aren't cut"
                      onClick={() => run(model.id, 'Creating…', hubApi.longContext)}
                    >
                      Long context
                    </button>
                  )}
                  <button
                    className={button}
                    onClick={() => window.confirm(`Delete ${model.name}? Downloading it again takes ${model.sizeGB} GB.`) && run(model.id, 'Deleting…', hubApi.deleteModel)}
                  >
                    Delete
                  </button>
                </>
              ) : (
                rating !== 'too big' && (
                  <button className={button} onClick={() => run(model.id, '0%', hubApi.pullModel)}>
                    Download
                  </button>
                )
              )}
            </div>
          </Row>
        )
      })}
    </Card>
  )
}
