import { definePluginSettings } from '@treeix/sdk'
import type { SearchEngine } from './address'

const ENGINES: SearchEngine[] = ['google', 'duckduckgo', 'bing']

export const browserSettings = definePluginSettings('browser', (stored) => ({
  /** Links ⌘-clicked in terminals open here instead of the system browser */
  openLinks: stored.openLinks !== false,
  searchEngine: ENGINES.find((engine) => engine === stored.searchEngine) ?? 'google'
}))
