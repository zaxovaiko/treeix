import type { Rule } from '../shared/types'

export type Tab = { url: string; title: string }

/** A call seen right now; `key` tells two calls in the same app apart */
export type Call = { name: string; app: string; url: string | null; key: string }

const pattern = (source: string): RegExp | null => {
  try {
    return new RegExp(source)
  } catch {
    return null
  }
}

/** Whether a rule needs Chrome's tabs: reading them launches Chrome, so it's only done while Chrome holds the microphone */
export const needsTabs = (rules: Rule[], micApps: string[]): boolean => rules.some((rule) => rule.url && micApps.some((app) => app.startsWith(rule.app)))

/** The first rule a microphone user (and for URL rules, a Chrome tab) matches */
export function detect(rules: Rule[], micApps: string[], tabs: Tab[]): Call | null {
  for (const rule of rules) {
    if (!rule.app || !micApps.some((app) => app.startsWith(rule.app))) continue
    if (!rule.url) return { name: rule.name, app: rule.app, url: null, key: rule.app }
    const match = pattern(rule.url)
    for (const tab of tabs) {
      const found = match?.exec(tab.url)?.[0]
      if (found) return { name: rule.name, app: rule.app, url: tab.url, key: `${rule.app} ${found}` }
    }
  }
  return null
}

/** `dismissed`: stopped by hand, so the same call doesn't start again until it's gone */
export type DetectorState = { state: 'idle' } | { state: 'pending'; call: Call; since: number } | { state: 'recording'; call: Call; lastSeen: number } | { state: 'dismissed' }

export type Delays = { startMs: number; stopMs: number }

/** One tick: a call has to stay `startMs` before recording starts and be gone `stopMs` before it stops, since apps keep the mic while muted */
export function step(current: DetectorState, seen: Call | null, now: number, delays: Delays): { next: DetectorState; action: 'start' | 'stop' | null } {
  switch (current.state) {
    case 'idle':
      return { next: seen ? { state: 'pending', call: seen, since: now } : current, action: null }
    case 'pending':
      if (!seen) return { next: { state: 'idle' }, action: null }
      if (seen.key !== current.call.key) return { next: { state: 'pending', call: seen, since: now }, action: null }
      if (now - current.since < delays.startMs) return { next: current, action: null }
      return { next: { state: 'recording', call: current.call, lastSeen: now }, action: 'start' }
    case 'recording':
      if (seen) return { next: { ...current, lastSeen: now }, action: null }
      if (now - current.lastSeen < delays.stopMs) return { next: current, action: null }
      return { next: { state: 'idle' }, action: 'stop' }
    case 'dismissed':
      return { next: seen ? current : { state: 'idle' }, action: null }
  }
}
