import { DEFAULT_SETTINGS } from '../features'
import type { Api, KeepAwakeState, PhoneStatus, Secret, Settings, Ticket } from './api'

// Phase 4-5 settings, system, MCP and tickets demo (owners U6, A5). Settings persist in localStorage like the ui state

type SettingsApi = Pick<
  Api,
  | 'getSettings' | 'updateSettings' | 'onSettings' | 'hasSecret' | 'setSecret' | 'deleteSecret'
  | 'cliTools' | 'appVersion' | 'checkUpdate' | 'installUpdate' | 'keepAwake' | 'setKeepAwake' | 'onKeepAwake'
  | 'phoneStatus' | 'setPhone'
  | 'mcpStatus' | 'mcpInstall' | 'myTickets' | 'ticketDetail' | 'notionDatabases'
>

const SETTINGS_KEY = 'treeix-settings'

const TICKETS: Ticket[] = [
  { key: 'TRX-47', source: 'jira', kind: 'bug', title: 'Quick terminal loses its cwd after a restart', status: 'In Progress', url: 'https://treeix.atlassian.net/browse/TRX-47', project: 'TRX', updatedAt: '2026-10-21T16:20:00Z' },
  { key: 'TRX-52', source: 'jira', kind: 'story', title: 'Usage pill shows the weekly limit', status: 'To Do', url: 'https://treeix.atlassian.net/browse/TRX-52', project: 'TRX', updatedAt: '2026-10-20T09:05:00Z' },
  { key: 'TRX-58', source: 'jira', kind: 'task', title: 'Sign the Linux AppImage', status: 'To Do', url: 'https://treeix.atlassian.net/browse/TRX-58', project: 'TRX', updatedAt: '2026-10-18T11:40:00Z' },
  { key: '1a2b3c4d5e6f', source: 'notion', kind: 'task', title: 'Write the chat onboarding copy', status: 'Not started', url: 'https://www.notion.so/1a2b3c4d5e6f', project: 'Roadmap', updatedAt: '2026-10-19T14:00:00Z' },
]

const NODE = { login: 'me@example.com', dnsName: 'mac.tail1234.ts.net' }

const merge = (settings: Settings, patch: Record<string, unknown>): Settings => {
  const out: Record<string, unknown> = { ...settings }
  for (const [key, value] of Object.entries(patch)) {
    const prev = out[key]
    out[key] = value && typeof value === 'object' && prev && typeof prev === 'object' ? { ...prev, ...value } : value
  }
  return out as Settings
}

export function settingsMock(): SettingsApi {
  const saved = localStorage.getItem(SETTINGS_KEY)
  let settings = merge(DEFAULT_SETTINGS, saved ? (JSON.parse(saved) as Record<string, unknown>) : {})
  const settingsListeners = new Set<(s: Settings) => void>()
  const awakeListeners = new Set<(s: KeepAwakeState) => void>()
  const secrets = new Set<Secret>()
  let awake: KeepAwakeState = { on: false, active: false }
  let mcpInstalled = false
  const phone = (): PhoneStatus => ({ node: NODE, problem: null, on: settings.phone.owner !== null, url: `https://${NODE.dnsName}/` })

  return {
    getSettings: async () => settings,
    async updateSettings(patch) {
      settings = merge(settings, patch)
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
      settingsListeners.forEach((cb) => cb(settings))
      return settings
    },
    onSettings(cb) {
      settingsListeners.add(cb)
      return () => settingsListeners.delete(cb)
    },
    hasSecret: async (secret) => secrets.has(secret),
    async setSecret(secret, value) {
      if (!value.trim()) throw new Error('empty secret')
      secrets.add(secret)
    },
    deleteSecret: async (secret) => void secrets.delete(secret),

    cliTools: async () => [
      { name: 'claude', installed: true, version: '2.1.4', signedIn: true, account: 'me@example.com', update: null },
      { name: 'codex', installed: true, version: '0.48.0', signedIn: true, account: null, update: '0.49.0' },
      { name: 'acli', installed: true, version: '1.3.2', signedIn: false, account: null, update: null },
      { name: 'gh', installed: true, version: '2.82.0', signedIn: true, account: 'me', update: null },
      { name: 'glab', installed: false, version: null, signedIn: null, account: null, update: null },
    ],
    appVersion: async () => '0.48.2',
    checkUpdate: async () => ({ version: '0.49.0', notes: '## Features\n\n- Chats survive an app restart' }),
    async installUpdate() {
      location.reload()
    },
    keepAwake: async () => awake,
    async setKeepAwake(on) {
      awake = { on, active: on && settings.awake.mode !== 'off' }
      awakeListeners.forEach((cb) => cb(awake))
      return awake
    },
    onKeepAwake(cb) {
      awakeListeners.add(cb)
      return () => awakeListeners.delete(cb)
    },

    phoneStatus: async () => phone(),
    async setPhone(on) {
      settings = merge(settings, { phone: { owner: on ? NODE.login : null } })
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
      settingsListeners.forEach((cb) => cb(settings))
      return phone()
    },

    mcpStatus: async () => ({
      running: settings.features.mcp,
      url: settings.features.mcp ? 'http://127.0.0.1:47613/mcp' : null,
      installs: [
        { agent: 'claude', state: mcpInstalled ? 'installed' : 'outdated' },
        { agent: 'codex', state: mcpInstalled ? 'installed' : 'missing' },
      ],
      tools: [
        { name: 'open_file', description: 'Open a file in the editor at a line' },
        { name: 'open_worktree', description: 'Create a worktree and open it' },
        { name: 'list_sessions', description: 'Sessions with their status and folder' },
      ],
    }),
    async mcpInstall() {
      mcpInstalled = true
      return { installed: ['claude', 'codex'], failed: [] }
    },
    myTickets: async () => ({
      tickets: TICKETS.filter((t) => settings.features[t.source]),
      errors: settings.features.notion && !secrets.has('notionToken') ? [{ source: 'notion', message: 'Add a Notion token in Settings > Notion' }] : [],
    }),
    async ticketDetail(source, key) {
      const ticket = TICKETS.find((t) => t.source === source && t.key === key)
      if (!ticket) throw new Error(`no ticket ${key}`)
      return { ticket, description: `${ticket.title}.\n\n## Acceptance\n\n- Works after a restart\n- Covered by a test` }
    },
    notionDatabases: async () => (secrets.has('notionToken') ? [{ id: 'db-roadmap', title: 'Roadmap' }, { id: 'db-bugs', title: 'Bugs' }] : []),
  }
}
