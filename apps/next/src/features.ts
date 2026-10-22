import type { Features, Settings } from './ipc/api'

// Phase 4-5 features and the Settings page layout. Each feature has an on/off switch (`settings.features`);
// off hides everything it adds: its settings sections, panels, palette actions and status items

export type FeatureId = keyof Features

export type SettingsSection = 'appearance' | 'terminal' | 'keys' | 'hotkey' | 'agents' | 'chats' | 'usage' | 'mcp' | 'jira' | 'notion' | 'prs' | 'awake' | 'features' | 'about'

export interface Feature {
  id: FeatureId
  label: string
  description: string
  /** Settings sections that show only while the feature is on */
  sections: SettingsSection[]
}

export const FEATURES = [
  { id: 'usage', label: 'Usage', description: 'Plan limits in the title bar and tokens per agent, model and project', sections: ['usage'] },
  { id: 'ports', label: 'Ports', description: 'Ports your sessions listen on, with open and kill', sections: [] },
  { id: 'chat', label: 'Chat', description: 'Claude and Codex as a chat beside the terminal, kept alive across restarts', sections: ['chats'] },
  { id: 'mcp', label: 'MCP server', description: 'Lets agents open files, panes and worktrees in Treeix', sections: ['mcp'] },
  { id: 'jira', label: 'Jira', description: 'Your Jira tickets in Open worktree, through acli', sections: ['jira'] },
  { id: 'notion', label: 'Notion', description: 'Your Notion tickets in Open worktree', sections: ['notion'] },
  { id: 'prs', label: 'Pull requests', description: 'GitHub and GitLab pull requests and their checks', sections: ['prs'] },
  { id: 'awake', label: 'Keep awake', description: 'Keeps the Mac awake while agents work', sections: ['awake'] },
  { id: 'race', label: 'Race', description: 'One prompt to several agents, a worktree each', sections: [] },
] as const satisfies readonly Feature[]

/** The Settings sidebar; a section that belongs to an off feature is hidden */
export const SETTINGS_NAV: readonly [group: string, sections: readonly SettingsSection[]][] = [
  ['App', ['appearance', 'terminal', 'keys', 'hotkey']],
  ['Agents', ['agents', 'chats', 'usage', 'mcp']],
  ['Integrations', ['jira', 'notion', 'prs']],
  ['Tools', ['awake']],
  ['More', ['features', 'about']],
]

export const sectionVisible = (section: SettingsSection, features: Features) =>
  FEATURES.every((f) => features[f.id] || !(f.sections as readonly SettingsSection[]).includes(section))

/** name, --background, --primary; the first of each list is the default and sets nothing */
export const THEMES = {
  dark: [
    ['Neutral', '#000', '#4f5ff0'], ['Vercel', '#0a0a0a', '#ededed'], ['Claude', '#1f1e1d', '#d97757'], ['Apple', '#1e1e1e', '#0a84ff'],
    ['Xcode', '#1f1f24', '#4eb0cc'], ['VS Code', '#1f1f1f', '#0078d4'], ['GitHub', '#0d1117', '#2f81f7'], ['Solarized', '#002b36', '#268bd2'],
    ['Onyx', '#0b0b0c', '#a3a3a3'], ['Coal', '#141414', '#f97316'], ['Midnight', '#0b1020', '#7c8cff'], ['Graphite', '#1c1c1e', '#98989d'],
    ['Nord', '#2e3440', '#88c0d0'], ['Dracula', '#282a36', '#bd93f9'],
  ],
  light: [
    ['Light', '#fff', '#4f5ff0'], ['Vercel', '#fff', '#171717'], ['Claude', '#faf9f5', '#c96442'], ['Apple', '#fff', '#007aff'],
    ['Xcode', '#fff', '#0e68d9'], ['VS Code', '#fff', '#005fb8'], ['GitHub', '#fff', '#0969da'], ['Solarized', '#fdf6e3', '#268bd2'],
  ],
} as const satisfies Record<'dark' | 'light', readonly (readonly [string, string, string])[]>

/** Mirrors the Rust defaults (crates/core/src/settings.rs); the mock starts from it */
export const DEFAULT_SETTINGS: Settings = {
  features: { usage: true, ports: true, chat: true, mcp: true, jira: false, notion: false, prs: true, awake: true, race: true },
  appearance: { darkTheme: 'Neutral', lightTheme: 'Light', followSystem: true },
  terminal: { fontFamily: 'JetBrains Mono', fontSize: 12, lineHeight: 1.2, cursorStyle: 'block', cursorBlink: true, scrollback: 10_000, copyOnSelect: false, optionAsMeta: true, shell: null, loginShell: true, confirmQuit: true },
  keys: {},
  agents: { skipPermissionsClaude: false, skipPermissionsCodex: false },
  chats: { defaultView: 'terminal', width: 760, showThinking: true, notify: true },
  usage: { pill: true, window: 'weekly', tray: 'icon' },
  jira: { jql: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC' },
  notion: { database: null },
  prs: { refreshMinutes: 5 },
  awake: { mode: 'untilAgentsFinish', lidClosed: false },
  updates: { autoCheck: true },
}
