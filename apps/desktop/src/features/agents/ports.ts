import { useCallback, useSyncExternalStore } from 'react'
import type { Api, SessionPort } from '../../ipc/api'

// Ports the sessions listen on, polled only while something shows them and the window is visible

const POLL_MS = 5000
const NONE: SessionPort[] = []
let ports = NONE
let timer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<() => void>()

export async function refreshPorts(api: Api) {
  const next = await api.sessionPorts().catch(() => ports)
  if (JSON.stringify(next) === JSON.stringify(ports)) return
  ports = next
  listeners.forEach((l) => l())
}

function subscribe(api: Api, listener: () => void) {
  listeners.add(listener)
  if (!timer) {
    void refreshPorts(api)
    timer = setInterval(() => document.visibilityState === 'visible' && void refreshPorts(api), POLL_MS)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size || !timer) return
    clearInterval(timer)
    timer = null
  }
}

const idle = () => () => {}

export function usePorts(api: Api, on: boolean) {
  const sub = useCallback((l: () => void) => subscribe(api, l), [api])
  return useSyncExternalStore(on ? sub : idle, () => (on ? ports : NONE))
}
