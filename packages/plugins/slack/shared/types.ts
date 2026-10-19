import { list, object } from '@treeix/shared/json'

/** What an AI Hub workflow starting on slack.messages asks of the batches, set on its input step */
export type Trigger = { intervalMin: number; includeOwn: boolean }

const DEFAULT_TRIGGER: Trigger = { intervalMin: 15, includeOwn: true }

/**
 * Merges the triggers of every workflow in the hub_workflows reply that starts on slack.messages: the shortest interval,
 * and own messages when any wants them. Options a workflow leaves out, or no such workflow at all, fall back to the defaults
 */
export function triggerOf(workflows: unknown): Trigger {
  const wanted = list(workflows)
    .flatMap((workflow) => list(workflow.nodes))
    .filter((node) => node.kind === 'input' && Array.isArray(node.events) && node.events.includes('slack.messages'))
    .map((node) => {
      const { intervalMin, includeOwn } = object(node.slack)
      return {
        intervalMin: Number.isInteger(intervalMin) && Number(intervalMin) >= 1 ? Number(intervalMin) : DEFAULT_TRIGGER.intervalMin,
        includeOwn: typeof includeOwn === 'boolean' ? includeOwn : DEFAULT_TRIGGER.includeOwn
      }
    })
  if (!wanted.length) return DEFAULT_TRIGGER
  return { intervalMin: Math.min(...wanted.map((trigger) => trigger.intervalMin)), includeOwn: wanted.some((trigger) => trigger.includeOwn) }
}

/** What Settings shows: whether the socket is up, what waits for the next batch, and the last thing that went wrong */
export type Status = { connected: boolean; pending: number; error: string | null; lastBatch: number | null }
