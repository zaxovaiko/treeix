import { definePluginSettings } from '@treeix/sdk'
import type { SearchEngine } from './address'

export type SavedAddress = { name: string; url: string }

const isSavedAddress = (value: unknown): value is SavedAddress =>
  typeof value === 'object' && value !== null && 'name' in value && 'url' in value && typeof value.name === 'string' && typeof value.url === 'string'

const ENGINES: SearchEngine[] = ['google', 'duckduckgo', 'bing']

export const browserSettings = definePluginSettings('browser', (stored) => ({
  /** Links ⌘-clicked in terminals open here instead of the system browser */
  openLinks: stored.openLinks !== false,
  searchEngine: ENGINES.find((engine) => engine === stored.searchEngine) ?? 'google',
  /** Addresses the address bar suggests, e.g. a staging site */
  saved: Array.isArray(stored.saved) ? (stored.saved as unknown[]).filter(isSavedAddress) : [],
  /** A card when a session starts listening on a new port */
  notifyPorts: stored.notifyPorts !== false
}))
