import { createBridge, createStore, definePluginSettings } from '@treeix/sdk'
import { parseSettings, type Status } from '../shared/types'

export const TAB_ID = 'meetings'
export const bridge = createBridge('meetings')
export const meetingsSettings = definePluginSettings('meetings', parseSettings)

/** Pushed by the main module, which owns the helper */
export const status = createStore<Status | null>(null)
/** Bumped whenever a meeting is added, changes or goes, so views read again */
export const revision = createStore(0)

export const button = 'h-7 rounded-md border border-border px-2.5 text-xs hover:bg-accent disabled:opacity-50'
