import { createBridge, createStore, definePluginSettings } from '@treeix/sdk'
import { type Dictation, type Status, parseSettings } from '../shared/types'

export const bridge = createBridge('dictation')

export const dictationSettings = definePluginSettings('dictation', parseSettings)

/** Pushed by the main module, which owns the helper and the history file */
export const status = createStore<Status | null>(null)
export const history = createStore<Dictation[]>([])
