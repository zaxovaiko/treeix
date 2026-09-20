import { createBridge } from '@treeix/sdk'
import type { Plan } from '../shared/types'

const bridge = createBridge('plans')

export const listPlans = (): Promise<Plan[]> => bridge.invoke<Plan[]>('list')
export const readPlan = (name: string): Promise<string | null> => bridge.invoke<string | null>('read', name)

const PLAN_POLL_MS = 3000
const listeners = new Set<(plans: Plan[]) => void>()
let latest: Plan[] | null = null
let timer: ReturnType<typeof setInterval> | null = null

const poll = (): void => {
  if (document.hidden) return
  void listPlans().then((plans) => {
    latest = plans
    listeners.forEach((listener) => listener(plans))
  }, () => undefined)
}

/** One poll of the plans folder for every plan button and view; runs while any is mounted and the window shows */
export function subscribePlans(listener: (plans: Plan[]) => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    poll()
    timer = setInterval(poll, PLAN_POLL_MS)
    document.addEventListener('visibilitychange', poll)
  } else if (latest) listener(latest)
  return () => {
    listeners.delete(listener)
    if (listeners.size > 0 || !timer) return
    clearInterval(timer)
    timer = null
    document.removeEventListener('visibilitychange', poll)
  }
}
