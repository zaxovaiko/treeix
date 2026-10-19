import { isJson, isString, list, text } from '@treeix/shared/json'
import { type Run, type Ticket, WATCH_AT_ONCE, type Watch, type Workflow } from '../shared/workflow'
import { jsonList } from './store'

/** One item a watch's query matched */
export type WatchItem = Ticket & { source: Watch['source']; title: string; labels: string[] }

/** What each watch matched on its last check, so only items that start matching start runs, also across relaunches */
type Seen = { id: string; keys: string[] }
const isSeen = (value: unknown): value is Seen => isJson(value) && isString(value.id) && Array.isArray(value.keys) && value.keys.every(isString)

/**
 * The items that start a run: newly matched and not already worked on. A watch's first check counts everything
 * it matches, so items marked before the workflow existed run too. Taking the mark off and putting it back runs one again.
 */
export const entering = (previous: Set<string> | null, current: WatchItem[], running: Set<string>): WatchItem[] =>
  current.filter((item) => !previous?.has(item.key) && !running.has(item.key))

/**
 * Starts as many entering items as there is room for. The rest are left out of what was seen, so a later check,
 * once a run has finished, finds them entering again
 */
export function admit(previous: Set<string> | null, current: WatchItem[], running: Set<string>, room: number): { start: WatchItem[]; seen: string[] } {
  const fresh = entering(previous, current, running)
  const start = fresh.slice(0, Math.max(0, room))
  const waiting = new Set(fresh.slice(start.length).map((item) => item.key))
  return { start, seen: current.flatMap((item) => (waiting.has(item.key) ? [] : [item.key])) }
}

/** The tool reply as items; the Jira and Notion plugins answer with JSON arrays */
export function watchItems(source: Watch['source'], reply: string): WatchItem[] {
  return list(JSON.parse(reply)).flatMap((entry): WatchItem[] => {
    const key = text(source === 'jira' ? entry.key : entry.id)
    const title = text(source === 'jira' ? entry.summary : entry.title)
    return key ? [{ source, key, title, url: text(entry.url) || null, labels: list(entry.labels, isString) }] : []
  })
}

/** A Notion watch waits for its data source */
const ready = (watch: Watch): boolean => watch.enabled && watch.query.trim() !== '' && (watch.source === 'jira' || Boolean(watch.dataSource))

const query = (watch: Watch): [string, Record<string, unknown>] =>
  watch.source === 'jira' ? ['jira_search', { jql: watch.query }] : ['notion_query', { dataSource: watch.dataSource ?? '', where: watch.query }]

/** Checks every enabled watch of every workflow; a failing watch reports once until its error changes */
export function createWatches(deps: {
  file: string
  workflows: () => Promise<Workflow[]>
  runs: () => Promise<Run[]>
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>
  launch: (workflow: Workflow, item: WatchItem) => Promise<void>
  failed: (workflow: Workflow, message: string) => void
}): () => Promise<void> {
  const seen = jsonList(deps.file, isSeen)
  const errors = new Map<string, string>()
  let checking = false

  return async () => {
    // A slow check is skipped on the next tick, never stacked
    if (checking) return
    checking = true
    try {
      const stored = new Map((await seen.get()).map((entry) => [entry.id, new Set(entry.keys)]))
      const runs = await deps.runs()
      const next: Seen[] = []
      for (const workflow of await deps.workflows()) {
        const running = new Set(runs.flatMap((run) => (run.status === 'running' && run.workflow.id === workflow.id && run.ticket ? [run.ticket.key] : [])))
        const input = workflow.nodes.find((node) => node.kind === 'input')
        let room = (input?.atOnce ?? WATCH_AT_ONCE) - running.size
        for (const watch of (input?.watches ?? []).filter(ready)) {
          const id = `${workflow.id}:${watch.id}`
          try {
            const items = watchItems(watch.source, await deps.callTool(...query(watch)))
            errors.delete(id)
            const { start, seen: keys } = admit(stored.get(id) ?? null, items, running, room)
            for (const item of start) await deps.launch(workflow, item)
            room -= start.length
            next.push({ id, keys })
          } catch (reason) {
            const message = reason instanceof Error ? reason.message : String(reason)
            if (errors.get(id) !== message) deps.failed(workflow, message)
            errors.set(id, message)
            // Kept as it was, so a passing outage doesn't rerun everything after it
            const previous = stored.get(id)
            if (previous) next.push({ id, keys: [...previous] })
          }
        }
      }
      await seen.set(next)
    } finally {
      checking = false
    }
  }
}
