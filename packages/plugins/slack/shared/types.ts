import type { Json } from '@treeix/shared/json'

export const INTERVALS = [5, 15, 30, 60] as const
export type Interval = (typeof INTERVALS)[number]

export type SlackSettings = { intervalMin: Interval; includeOwn: boolean }

export const parseSettings = (stored: Json): SlackSettings => ({
  intervalMin: INTERVALS.find((minutes) => minutes === stored.intervalMin) ?? 15,
  includeOwn: stored.includeOwn !== false
})

/** What Settings shows: whether the socket is up, what waits for the next batch, and the last thing that went wrong */
export type Status = { connected: boolean; pending: number; error: string | null; lastBatch: number | null }
