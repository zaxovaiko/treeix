import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseJson } from '@treeix/shared/json'
import { isRun, isRunEvent, type Run, type RunEvent } from '../shared/workflow'

export const KEEP_RUNS = 100

/** Joins a streamed reply's pieces, so a run's log holds blocks instead of one line per token */
export function mergeChunks(events: RunEvent[]): RunEvent[] {
  const merged: RunEvent[] = []
  for (const entry of events) {
    const last = merged.at(-1)
    const { event } = entry
    if (last?.node === entry.node && last.event.type === 'thought_chunk' && event.type === 'thought_chunk' && last.event.parent === event.parent) {
      merged[merged.length - 1] = { ...last, event: { ...last.event, text: last.event.text + event.text } }
    } else if (
      last?.node === entry.node &&
      last.event.type === 'message_chunk' &&
      last.event.content.type === 'text' &&
      event.type === 'message_chunk' &&
      event.content.type === 'text' &&
      last.event.role === event.role &&
      last.event.parent === event.parent
    ) {
      merged[merged.length - 1] = { ...last, event: { ...last.event, content: { type: 'text', text: last.event.content.text + event.content.text } } }
    } else merged.push(entry)
  }
  return merged
}

/** Each run as `<id>.json`, rewritten on every change, with its agents' events appended to `<id>.jsonl`; writes go one at a time */
export function createRuns(dir: string) {
  let writing = Promise.resolve()
  const queue = (work: () => Promise<unknown>): Promise<void> => {
    writing = writing.then(work).then(
      () => undefined,
      (error: unknown) => console.error('[hub] Writing runs failed', error)
    )
    return writing
  }
  const file = (id: string, extension: string): string => join(dir, `${id}.${extension}`)

  return {
    list: async (): Promise<Run[]> => {
      await writing
      const names = await readdir(dir).catch((): string[] => [])
      const runs = await Promise.all(names.filter((name) => name.endsWith('.json')).map(async (name) => parseJson(await readFile(join(dir, name), 'utf8').catch(() => null))))
      return runs.filter(isRun).sort((a, b) => b.startedAt - a.startedAt)
    },
    save: (run: Run): Promise<void> => {
      const body = JSON.stringify(run)
      return queue(async () => {
        await mkdir(dir, { recursive: true })
        await writeFile(file(run.id, 'json.tmp'), body)
        await rename(file(run.id, 'json.tmp'), file(run.id, 'json'))
      })
    },
    append: (id: string, events: RunEvent[]): Promise<void> => {
      const lines = events.map((event) => `${JSON.stringify(event)}\n`).join('')
      return queue(async () => {
        await mkdir(dir, { recursive: true })
        await appendFile(file(id, 'jsonl'), lines)
      })
    },
    events: async (id: string): Promise<RunEvent[]> => {
      await writing
      const lines = (await readFile(file(id, 'jsonl'), 'utf8').catch(() => '')).split('\n')
      return lines.flatMap((line) => (line ? [parseJson(line)] : [])).filter(isRunEvent)
    },
    remove: (ids: string[]): Promise<void> => queue(() => Promise.all(ids.flatMap((id) => [rm(file(id, 'json'), { force: true }), rm(file(id, 'jsonl'), { force: true })])))
  }
}

export type Runs = ReturnType<typeof createRuns>
