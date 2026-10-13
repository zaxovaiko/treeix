import { useEffect, useState } from 'react'
import { Card, Row } from '@treeix/app/settingsUi'
import { errorMessage } from '@treeix/app/ui'
import { fit, LOCAL_MODELS, type LocalModelsState, longContextId } from '../shared/catalog'
import { hubApi } from './store'

const button = 'h-7 rounded-md border border-border px-2.5 text-xs hover:bg-accent disabled:opacity-50'
const FIT_COLOR = { fits: 'text-emerald-400', tight: 'text-amber-400', 'too big': 'text-red-400' } as const

/** What a model is doing, or why its last action failed */
type Job = { label: string; failed: boolean }

/** Ollama models with ratings and whether they fit this Mac; agents and workflows pick them under the Ollama API */
export function HubSettings(): React.JSX.Element {
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
            description={
              job?.failed
                ? job.label
                : `${model.note} Quality ${model.quality}/5, speed ${model.speed}/5, ${model.sizeGB} GB. ${long ? `Long context: ${longContextId(model.id)}.` : model.id}`
            }
          >
            <div className="flex items-center gap-2">
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
