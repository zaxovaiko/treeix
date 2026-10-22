import { useCallback, useSyncExternalStore } from 'react'
import type { Api, Routine, RoutineRun, RoutinesEvent } from '../../ipc/api'

// One copy of the routines and their recent runs for the window, kept fresh by `onRoutines` while anything reads it

/** Runs kept for the rows' status and Recent runs */
const RUN_LIMIT = 50

export interface RoutinesState {
  /** Null until the first load */
  routines: Routine[] | null
  /** Newest first */
  runs: RoutineRun[]
  error: string | null
}

let state: RoutinesState = { routines: null, runs: [], error: null }
let stop: (() => void) | null = null
const listeners = new Set<() => void>()

const set = (patch: Partial<RoutinesState>) => {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

const byName = (list: Routine[]) => [...list].sort((a, b) => a.name.localeCompare(b.name))

function apply(e: RoutinesEvent) {
  const routines = state.routines ?? []
  switch (e.type) {
    case 'changed':
      return set({ routines: byName([...routines.filter((r) => r.id !== e.routine.id), e.routine]) })
    case 'removed':
      return set({ routines: routines.filter((r) => r.id !== e.routine) })
    case 'run': {
      const rest = state.runs.filter((r) => r.id !== e.run.id)
      return set({ runs: [e.run, ...rest].sort((a, b) => b.dueAt - a.dueAt).slice(0, RUN_LIMIT) })
    }
  }
}

function subscribe(api: Api, listener: () => void) {
  listeners.add(listener)
  if (!stop) {
    stop = api.onRoutines(apply)
    void Promise.all([api.routineList(), api.routineRuns(null, RUN_LIMIT)]).then(
      ([routines, runs]) => set({ routines: byName(routines), runs, error: null }),
      (e: unknown) => set({ routines: [], error: e instanceof Error ? e.message : String(e) })
    )
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size || !stop) return
    stop()
    stop = null
  }
}

export const useRoutines = (api: Api) => useSyncExternalStore(useCallback((l: () => void) => subscribe(api, l), [api]), () => state)

/** The last loaded state, for code outside React (palette command lists) */
export const routinesNow = () => state
