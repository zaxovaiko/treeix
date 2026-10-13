import { definePluginSettings } from '@treeix/sdk'

/** The session whose name is being edited in place */
export const renaming = definePluginSettings('terminal-rename', () => ({ id: null as string | null }))
export const startRename = (id: string): void => renaming.update({ id })
