import { useCallback, useSyncExternalStore } from 'react'
import type { Api, Settings } from '../../ipc/api'

// One settings copy for the window, kept fresh by `onSettings` while anything reads it

let current: Settings | null = null
let stop: (() => void) | null = null
const listeners = new Set<() => void>()

const set = (settings: Settings) => {
  current = settings
  listeners.forEach((l) => l())
}

function subscribe(api: Api, listener: () => void) {
  listeners.add(listener)
  if (!stop) {
    stop = api.onSettings(set)
    void api.getSettings().then(set)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size || !stop) return
    stop()
    stop = null
  }
}

/** Null until the first load */
export const useSettings = (api: Api) => useSyncExternalStore(useCallback((l: () => void) => subscribe(api, l), [api]), () => current)

/** The last loaded settings, for code outside React (palette command lists) */
export const settingsNow = () => current
