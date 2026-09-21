import { expect, test } from 'bun:test'
import type { ChatAdapter } from '@treeix/sdk/main'
import { adaptersOf } from './pluginAdapters'

const adapter = (id: string): ChatAdapter => ({ id, label: id, connect: () => Promise.reject(new Error('unused')) })

test('adaptersOf takes enabled plugins in order and keeps the first adapter per id', () => {
  const plugins = new Map([
    ['chat', { chatAdapters: [adapter('acp')] }],
    ['other', { chatAdapters: [adapter('acp'), adapter('native')] }],
    ['off', { chatAdapters: [adapter('ghost')] }]
  ])
  expect(adaptersOf(plugins, ['chat', 'other']).map((entry) => entry.id)).toEqual(['acp', 'native'])
})
