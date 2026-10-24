import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { FEATURES, THEMES, type FeatureId, type SettingsSection } from '../../features'
import type { CliTool, KeepAwakeState, McpStatus, NotionDatabase, Settings, SettingsPatch, UpdateInfo } from '../../ipc/api'
import { ACTIONS, conflict, defaultKeys, keyFor, type ActionId, type Keymap } from '../../lib/hotkeys'
import { registerQuickShortcut } from '../../lib/native'
import { IS_MAC, keyHint } from '../../shell/shortcuts'
import type { ShellView } from '../../shell/Shell'
import { ZOOM, type UiState } from '../../shell/state'
import type { Mode } from '../../styles/theme'
import { RoutinesSection } from '../../features/routines'
import { BrowserSection } from '../../features/browser'
import { RecordingSection, VoiceSection } from '../../features/voice'
import { PIcon, type PanelIconName } from '../../panels/common'
import { Icon, type IconName } from '../../lib/icons'
import { Field, Group, Recorder, Row, Seg, Select, Status, Switch, useHit } from './controls'

export interface SectionProps {
  view: ShellView
  settings: Settings
  update: (patch: SettingsPatch) => void
}

const setUi = (view: ShellView, patch: Partial<UiState>) => view.dispatch({ type: 'set', patch })

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Loads on mount and whenever `key` changes; `reload` asks again */
function useLoad<T>(load: () => Promise<T>, key: unknown = null): [T | null, string | null, () => void] {
  const [state, setState] = useState<{ value: T | null; error: string | null }>({ value: null, error: null })
  const [round, setRound] = useState(0)
  useEffect(() => {
    let live = true
    load().then(
      (value) => live && setState({ value, error: null }),
      (e: unknown) => live && setState({ value: null, error: message(e) })
    )
    return () => {
      live = false
    }
  }, [round, key])
  return [state.value, state.error, () => setRound((r) => r + 1)]
}

function ThemeGrid({ mode, view, settings, update }: SectionProps & { mode: Mode }) {
  const current = mode === 'light' ? settings.appearance.lightTheme : settings.appearance.darkTheme
  return (
    <div className="thgrid">
      {THEMES[mode].map(([name, background, primary]) => (
        <button
          key={name}
          className={`thx ${name === current ? 'on' : ''}`}
          onClick={() => {
            update({ appearance: mode === 'light' ? { lightTheme: name } : { darkTheme: name } })
            // Following the system, the OS picks which of the two shows
            if (!settings.appearance.followSystem) setUi(view, { theme: mode })
          }}
        >
          <span className="pv" style={{ background, color: mode === 'light' ? '#1b1b1f' : '#f5f5f5' }}>
            <i style={{ width: '60%' }} />
            <i style={{ width: '40%', background: primary }} />
            <i style={{ width: '75%' }} />
          </span>
          <span className="nm">{name}</span>
        </button>
      ))}
    </div>
  )
}

function Appearance(props: SectionProps) {
  const { view, settings, update } = props
  const mode = settings.appearance.followSystem ? 'system' : view.ui.theme
  return (
    <>
      <Group title="Theme">
        <Row label="Mode" desc={`System follows ${IS_MAC ? 'macOS' : 'the desktop'}`}>
          <Seg
            value={mode}
            options={[['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]}
            onChange={(next) => {
              update({ appearance: { followSystem: next === 'system' } })
              if (next !== 'system') setUi(view, { theme: next })
            }}
          />
        </Row>
        <Row label="Dark" keywords={`themes ${THEMES.dark.map(([n]) => n).join(' ')}`} wide>
          <ThemeGrid mode="dark" {...props} />
        </Row>
        <Row label="Light" keywords={`themes ${THEMES.light.map(([n]) => n).join(' ')}`} wide>
          <ThemeGrid mode="light" {...props} />
        </Row>
      </Group>
      <Group title="Layout">
        <Row label="Tabs" desc="Grouped in a sidebar, or a strip on top. With Compact, the strip sits in the title bar">
          <Seg value={view.ui.orientation} options={[['vertical', 'Vertical'], ['horizontal', 'Horizontal']]} onChange={(orientation) => setUi(view, { orientation })} />
        </Row>
        <Row label="Density" desc="Compact runs edge to edge with 1px lines. Islands floats rounded panels">
          <Seg value={view.ui.ui} options={[['compact', 'Compact'], ['islands', 'Islands']]} onChange={(ui) => setUi(view, { ui })} />
        </Row>
        <Row label="Zoom" desc={`The whole window. ${keyHint('zoom-in')} and ${keyHint('zoom-out')} step it, ${keyHint('zoom-reset')} resets`} keywords="scale size bigger smaller">
          <Select value={view.ui.zoom} options={ZOOM_STEPS.map((z) => [z, `${Math.round(z * 100)}%`] as const)} onChange={(zoom) => setUi(view, { zoom })} />
        </Row>
      </Group>
    </>
  )
}

const ZOOM_STEPS = Array.from({ length: Math.round((ZOOM.max - ZOOM.min) / ZOOM.step) + 1 }, (_, i) => Math.round((ZOOM.min + i * ZOOM.step) * 10) / 10)

const FONTS = ['JetBrains Mono', 'SF Mono', 'Menlo', 'Fira Code', 'Berkeley Mono', 'IBM Plex Mono', 'ui-monospace']

function Terminal({ view, settings, update }: SectionProps) {
  const t = settings.terminal
  const set = (patch: Partial<Settings['terminal']>) => update({ terminal: patch })
  return (
    <>
      <Group title="Text">
        <Row label="Font" desc="Any monospace font installed here">
          <Select value={t.fontFamily} options={(FONTS.includes(t.fontFamily) ? FONTS : [t.fontFamily, ...FONTS]).map((f) => [f, f] as const)} onChange={(fontFamily) => set({ fontFamily })} />
        </Row>
        <Row label="Size" desc="9 to 24">
          <Field type="number" min={9} max={24} width={64} value={String(t.fontSize)} onSave={(v) => set({ fontSize: Math.min(24, Math.max(9, Math.round(Number(v)) || 12)) })} />
        </Row>
        <Row label="Line height">
          <Select value={t.lineHeight} options={[1, 1.1, 1.2, 1.3, 1.4, 1.5].map((n) => [n, n.toFixed(1)] as const)} onChange={(lineHeight) => set({ lineHeight })} />
        </Row>
      </Group>
      <Group title="Cursor">
        <Row label="Style">
          <Seg value={t.cursorStyle} options={[['block', 'Block'], ['bar', 'Bar'], ['underline', 'Underline']]} onChange={(cursorStyle) => set({ cursorStyle })} />
        </Row>
        <Row label="Blink">
          <Switch label="Blink" on={t.cursorBlink} onChange={(cursorBlink) => set({ cursorBlink })} />
        </Row>
      </Group>
      <Group title="Behaviour">
        <Row label="Scrollback" desc="Lines kept per pane">
          <Select value={t.scrollback} options={[1000, 3000, 5000, 10000, 20000, 50000].map((n) => [n, n.toLocaleString('en')] as const)} onChange={(scrollback) => set({ scrollback })} />
        </Row>
        <Row label="Open files in Treeix" desc="Cmd-clicked paths open in the file view. Off opens them in their default app" keywords="finder link click path external">
          <Switch label="Open files in Treeix" on={t.openFilesInApp} onChange={(openFilesInApp) => set({ openFilesInApp })} />
        </Row>
        <Row label="Copy on select">
          <Switch label="Copy on select" on={t.copyOnSelect} onChange={(copyOnSelect) => set({ copyOnSelect })} />
        </Row>
        {IS_MAC && (
          <Row label="Option as Meta" desc="Option sends Meta to the shell instead of typing characters like ą and ś">
            <Switch label="Option as Meta" on={t.optionAsMeta} onChange={(optionAsMeta) => set({ optionAsMeta })} />
          </Row>
        )}
        <Row label="Renderer" desc="WebGL is fastest. DOM for old GPUs and screen sharing. Auto uses WebGL, except DOM on Linux">
          <Seg value={view.ui.renderer} options={[['auto', 'Auto'], ['webgl', 'WebGL'], ['dom', 'DOM']]} onChange={(renderer) => setUi(view, { renderer })} />
        </Row>
      </Group>
      <Group title="Shell">
        <Row label="Shell" desc="Empty uses $SHELL">
          <Field mono value={t.shell ?? ''} placeholder="$SHELL" onSave={(v) => set({ shell: v.trim() || null })} />
        </Row>
        <Row label="Login shell" desc={`Loads ${IS_MAC ? '.zprofile' : '.profile'}, so PATH matches the system terminal`}>
          <Switch label="Login shell" on={t.loginShell} onChange={(loginShell) => set({ loginShell })} />
        </Row>
        <Row label="Ask before quitting" desc="When a shell still runs something, or an agent is working">
          <Switch label="Ask before quitting" on={t.confirmQuit} onChange={(confirmQuit) => set({ confirmQuit })} />
        </Row>
      </Group>
    </>
  )
}

const ACTION_ICON: Record<ActionId, IconName> = {
  'new-shell': 'terminal',
  'new-claude': 'claude',
  'new-codex': 'codex',
  'open-folder': 'folder',
  'split-right': 'split',
  'split-down': 'splitDown',
  'close-pane': 'x',
  'reopen-tab': 'clock',
  'next-tab': 'right',
  'prev-tab': 'left',
  palette: 'search',
  'toggle-sidebar': 'sideL',
  settings: 'gear',
  'toggle-tabs': 'layout',
  'toggle-ui': 'islands',
  'toggle-theme': 'moon',
  'module-graph': 'network',
  record: 'rec',
  'zoom-in': 'zoomIn',
  'zoom-out': 'zoomOut',
  'zoom-reset': 'search',
}

function Keys({ settings, update }: SectionProps) {
  const keys = settings.keys
  const defaults = defaultKeys()
  return (
    <>
      {[...new Set(ACTIONS.map(([, , group]) => group))].map((group) => (
        <Group key={group} title={group}>
          {ACTIONS.filter((action) => action[2] === group).map(([id, label]) => {
            const accel = keyFor(id, keys)
            const clash = conflict(id, accel, keys)
            return (
              <Row key={id} label={label} icon={<Icon name={ACTION_ICON[id]} className="kico" />} desc={clash ? <span className="warn">{clash}</span> : undefined} keywords="shortcut keys">
                <Recorder
                  label={label}
                  value={accel}
                  onChange={(next) => {
                    // The default again drops the override, so a later change to the default reaches it
                    const value = next ?? ''
                    update({ keys: { ...withoutKey(keys, id), ...(value === (defaults[id] ?? '') ? {} : { [id]: value }) } })
                  }}
                />
              </Row>
            )
          })}
        </Group>
      ))}
      <Group>
        <Row label="Reset all shortcuts" keywords="shortcut keys default">
          <button className="btn sm" disabled={!Object.keys(keys).length} onClick={() => update({ keys: {} })}>
            Reset
          </button>
        </Row>
      </Group>
    </>
  )
}

const withoutKey = (keys: Keymap, id: ActionId) => Object.fromEntries(Object.entries(keys).filter(([k]) => k !== id))

function Hotkey({ view, settings }: SectionProps) {
  const accel = view.ui.quickShortcut
  const clash = conflict('quick', accel, settings.keys)
  return (
    <Group>
      <Row label="Quick terminal" desc={clash ? <span className="warn">{clash}</span> : 'A small terminal over every app and window, from anywhere'} keywords="global shortcut hotkey window">
        <Recorder
          label="Quick terminal"
          value={accel}
          onChange={async (quickShortcut) => {
            await registerQuickShortcut(quickShortcut)
            setUi(view, { quickShortcut })
          }}
        />
      </Row>
      <Row label="Slide in" desc="Off, it appears at once" keywords="quick terminal hotkey animation">
        <Switch label="Slide in" on={view.ui.quickAnimate} onChange={(quickAnimate) => setUi(view, { quickAnimate })} />
      </Row>
      <Row label="Opacity" desc={`${Math.round(view.ui.quickOpacity * 100)}%, macOS only`} keywords="quick terminal hotkey transparency transparent">
        <input type="range" className="range" aria-label="Quick terminal opacity" min={0.3} max={1} step={0.05} value={view.ui.quickOpacity} onChange={(e) => setUi(view, { quickOpacity: Number(e.target.value) })} />
      </Row>
      <Row label="Blur background" desc="What shows through is blurred, macOS only" keywords="quick terminal hotkey transparency transparent frosted glass">
        <Switch label="Blur background" on={view.ui.quickBlur} onChange={(quickBlur) => setUi(view, { quickBlur })} />
      </Row>
    </Group>
  )
}

const SIGN_IN: Record<string, string> = { gh: 'gh auth login', glab: 'glab auth login', codex: 'codex login', acli: 'acli jira auth login', claude: 'claude /login' }

function cliNote(tool: CliTool): [tone: 'ok' | 'warn' | 'bad' | 'idle', note: ReactNode] {
  if (!tool.installed) return ['bad', 'Not found on PATH']
  if (tool.signedIn === false) return ['warn', <>Not signed in. Run <code>{SIGN_IN[tool.name] ?? `${tool.name} login`}</code></>]
  if (tool.update) return ['warn', `Update available: ${tool.update}`]
  if (tool.signedIn) return ['ok', tool.account ? `Signed in as ${tool.account}` : 'Signed in']
  return ['ok', '']
}

function Agents({ view, settings, update }: SectionProps) {
  const [tools, error, reload] = useLoad(() => view.api.cliTools())
  const a = settings.agents
  return (
    <>
      <Group title="Permissions">
        <Row label="Skip Claude permissions" desc={<>Starts Claude with <code>--dangerously-skip-permissions</code>{a.skipPermissionsClaude && <span className="warn"> · edits and commands run without asking</span>}</>} keywords="dangerously skip permissions claude">
          <Switch label="Skip Claude permissions" on={a.skipPermissionsClaude} onChange={(skipPermissionsClaude) => update({ agents: { skipPermissionsClaude } })} />
        </Row>
        <Row label="Skip Codex approvals and sandbox" desc={<>Starts Codex with <code>--dangerously-bypass-approvals-and-sandbox</code>{a.skipPermissionsCodex && <span className="warn"> · no sandbox</span>}</>} keywords="dangerously bypass approvals sandbox codex">
          <Switch label="Skip Codex approvals and sandbox" on={a.skipPermissionsCodex} onChange={(skipPermissionsCodex) => update({ agents: { skipPermissionsCodex } })} />
        </Row>
      </Group>
      <Group title="Command line tools">
        <Row label="" keywords="command line tools claude codex acli gh glab path signed in version update check again" wide>
          <div style={{ width: '100%' }}>
            {error && <div className="sd st-err">{error}</div>}
            {!tools && !error && <div className="dim">Checking...</div>}
            {tools?.map((tool) => {
              const [tone, note] = cliNote(tool)
              return (
                <div key={tool.name} className="clirow">
                  <span className={`sdot ${tone}`} />
                  <b className="mono">{tool.name}</b>
                  <span className="dim ver">{tool.version ?? ''}</span>
                  <span className="grow dim">{note}</span>
                </div>
              )
            })}
            <button className="btn sm clicheck" onClick={reload}>
              Check again
            </button>
          </div>
        </Row>
      </Group>
    </>
  )
}

function Chats({ settings, update }: SectionProps) {
  const c = settings.chats
  return (
    <Group>
      <Row label="Agent tabs open as" desc="The same session either way: switch any pane with the Chat button in its footer">
        <Seg value={c.defaultView} options={[['terminal', 'Terminal'], ['chat', 'Chat']]} onChange={(defaultView) => update({ chats: { defaultView } })} />
      </Row>
      <Row label="Chat width" desc="Widest the conversation column gets, in pixels">
        <Field type="number" min={480} max={1600} width={72} value={String(c.width)} onSave={(v) => update({ chats: { width: Math.min(1600, Math.max(480, Math.round(Number(v)) || 760)) } })} />
      </Row>
      <Row label="Show thinking">
        <Switch label="Show thinking" on={c.showThinking} onChange={(showThinking) => update({ chats: { showThinking } })} />
      </Row>
      <Row label="Agent notifications" desc="When an agent finishes or needs you and Treeix is in the background">
        <Switch label="Agent notifications" on={c.notify} onChange={(notify) => update({ chats: { notify } })} />
      </Row>
    </Group>
  )
}

function Usage({ settings, update }: SectionProps) {
  const u = settings.usage
  return (
    <Group>
      <Row label="Meter in the title bar" desc="Plan usage of Claude, else Codex">
        <Switch label="Meter in the title bar" on={u.pill} onChange={(pill) => update({ usage: { pill } })} />
      </Row>
      <Row label="Window" desc="Which limit the meter shows">
        <Seg value={u.window} options={[['fiveHour', '5-hour'], ['weekly', 'Weekly']]} onChange={(window) => update({ usage: { window } })} />
      </Row>
      <Row label={IS_MAC ? 'Menu bar' : 'Tray'} desc="Next to the icon. Sessions that need you show there too">
        <Seg value={u.tray} options={[['off', 'Off'], ['icon', 'Icon only'], ['weekly', 'Weekly'], ['fiveHour', '5-hour'], ['rings', 'Both']]} onChange={(tray) => update({ usage: { tray } })} />
      </Row>
    </Group>
  )
}

function Mcp({ view }: SectionProps) {
  const [status, error, reload] = useLoad(() => view.api.mcpStatus())
  const [installing, setInstalling] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const install = async () => {
    setInstalling(true)
    try {
      const done = await view.api.mcpInstall()
      setResult(done.failed.length ? done.failed.map(([agent, why]) => `${agent}: ${why}`).join(', ') : null)
    } catch (e) {
      setResult(message(e))
    }
    setInstalling(false)
    reload()
  }
  const missing = status?.installs.some((i) => i.state !== 'installed') ?? false
  return (
    <>
      <Group>
        <Row label="Server" desc={status?.url ?? 'Lets agents open files, panes and worktrees here'} keywords="mcp url running">
          {error ? <span className="st-err">{error}</span> : status && <Status tone={status.running ? 'ok' : 'bad'}>{status.running ? 'Running' : 'Not running'}</Status>}
        </Row>
        {status?.installs.map((i) => (
          <Row key={i.agent} label={i.agent === 'claude' ? 'Claude Code' : 'Codex'} keywords="mcp install set up">
            <McpState status={i.state} />
          </Row>
        ))}
        <Row label="" keywords="mcp install set up">
          {result && <span className="st-err">{result}</span>}
          <button className={`btn sm ${missing ? 'pri' : ''}`} disabled={installing || !status?.running} onClick={() => void install()}>
            {installing ? 'Setting up...' : missing ? 'Set up' : 'Set up again'}
          </button>
        </Row>
      </Group>
      {!!status?.tools.length && (
        <Group title="Tools">
          {status.tools.map((tool) => (
            <Row key={tool.name} label={tool.name} desc={tool.description} keywords="mcp tools" />
          ))}
        </Group>
      )}
    </>
  )
}

const McpState = ({ status }: { status: McpStatus['installs'][number]['state'] }) =>
  status === 'installed' ? <Status tone="ok">Set up</Status> : status === 'outdated' ? <Status tone="warn">Old address, set up again</Status> : <Status tone="idle">Not set up</Status>

function Jira({ settings, update }: SectionProps) {
  return (
    <Group>
      <Row label="Your tickets" desc="JQL for the tickets Open worktree suggests, through acli" keywords="jql query">
        <Field mono width={320} value={settings.jira.jql} onSave={(jql) => update({ jira: { jql: jql.trim() } })} />
      </Row>
    </Group>
  )
}

function Notion({ view, settings, update }: SectionProps) {
  const api = view.api
  const [saved, , recheck] = useLoad(() => api.hasSecret('notionToken'))
  const [databases, dbError] = useLoad<NotionDatabase[]>(() => (saved ? api.notionDatabases() : Promise.resolve([])), saved)
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const run = (work: Promise<void>) =>
    work.then(
      () => {
        setError(null)
        setToken('')
        recheck()
      },
      (e: unknown) => setError(message(e))
    )
  return (
    <Group>
      <Row label="Personal access token" desc="Stored in the keychain, never shown again" keywords="secret integration token">
        {error && <span className="st-err">{error}</span>}
        {saved ? (
          <>
            <Status tone="ok">Saved</Status>
            <button className="btn sm" onClick={() => void run(api.deleteSecret('notionToken'))}>
              Remove
            </button>
          </>
        ) : (
          <>
            <input className="inp mono" type="password" style={{ width: 200 }} placeholder="ntn_..." value={token} spellCheck={false} onChange={(e) => setToken(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && token.trim() && void run(api.setSecret('notionToken', token))} />
            <button className="btn" disabled={!token.trim()} onClick={() => void run(api.setSecret('notionToken', token))}>
              Save
            </button>
          </>
        )}
      </Row>
      <Row label="Tasks database" desc={dbError ?? (saved ? 'Its tasks show up as tickets in Open worktree' : 'Save a token first')} keywords="database tickets">
        <Select
          value={settings.notion.database ?? ''}
          options={[['', databases?.length ? 'Pick one' : 'None'], ...(databases ?? []).map((d) => [d.id, d.title] as const)]}
          onChange={(database) => update({ notion: { database: database || null } })}
        />
      </Row>
    </Group>
  )
}

function Prs({ settings, update }: SectionProps) {
  return (
    <Group>
      <Row label="Refresh" desc="How often open pull requests and their checks reload">
        <Seg value={settings.prs.refreshMinutes} options={[[1, '1 min'], [5, '5 min'], [15, '15 min'], [30, '30 min']]} onChange={(refreshMinutes) => update({ prs: { refreshMinutes } })} />
      </Row>
    </Group>
  )
}

function Awake({ view, settings, update }: SectionProps) {
  const [state, setState] = useState<KeepAwakeState | null>(null)
  useEffect(() => {
    void view.api.keepAwake().then(setState)
    return view.api.onKeepAwake(setState)
  }, [view.api])
  return (
    <Group>
      <Row label="Keep awake" desc={state?.active ? 'Holding now' : state?.on ? 'Waiting for an agent to run' : 'Off'} keywords="sleep caffeinate">
        <Seg value={settings.awake.mode} options={[['off', 'Off'], ['untilAgentsFinish', 'While agents work'], ['on', 'Always']]} onChange={(mode) => update({ awake: { mode } })} />
      </Row>
      {IS_MAC && (
        <Row label="Keep running with the lid closed" desc="Needs power. Asks for your password each time it changes" keywords="lid sleep pmset">
          <Switch label="Keep running with the lid closed" on={settings.awake.lidClosed} onChange={(lidClosed) => update({ awake: { lidClosed } })} />
        </Row>
      )}
    </Group>
  )
}

function Phone({ view }: SectionProps) {
  const [status, error, reload] = useLoad(() => view.api.phoneStatus())
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const toggle = async (on: boolean) => {
    setBusy(true)
    setFailed(null)
    try {
      await view.api.setPhone(on)
    } catch (e) {
      setFailed(message(e))
    }
    setBusy(false)
    reload()
  }
  const problem = error ?? status?.problem
  const url = status?.on ? status.url : null
  return (
    <Group>
      <Row label="Phone page" desc="Agents, chats and routines in your phone's browser, only for your Tailscale account. Asks for your password each time it changes" keywords="phone mobile iphone tailscale remote">
        {busy ? <Status tone="idle">Waiting for your password</Status> : <Switch label="Phone page" on={status?.on ?? false} onChange={(on) => void toggle(on)} />}
      </Row>
      <Row label="Tailscale" desc={problem ? 'Install Tailscale on this Mac and your phone, and sign in to both with one account' : undefined} keywords="tailscale account tailnet">
        {problem ? <Status tone="bad">{problem}</Status> : status?.node && <Status tone="ok">{status.node.login}</Status>}
      </Row>
      {url && (
        <Row label="Address" desc={url} keywords="phone url address link">
          <button className="btn sm" onClick={() => void navigator.clipboard.writeText(url).then(() => setCopied(true))}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button className="btn sm" onClick={() => void view.api.openUrl(url)}>
            Open
          </button>
        </Row>
      )}
      {failed && (
        <Row label="">
          <span className="st-err">{failed}</span>
        </Row>
      )}
    </Group>
  )
}

const ART: Record<FeatureId, [PanelIconName | IconName, string]> = {
  usage: ['gauge', 'amber'],
  ports: ['plug', 'sky'],
  chat: ['comment', 'violet'],
  mcp: ['mcp', 'foreground'],
  jira: ['jira', 'sky'],
  notion: ['notion', 'foreground'],
  prs: ['github', 'foreground'],
  awake: ['coffee', 'amber'],
  race: ['fork', 'red'],
  routines: ['clock', 'violet'],
  browser: ['globe', 'sky'],
  plans: ['map', 'green'],
  graph: ['network', 'primary'],
  dictation: ['mic', 'red'],
  recording: ['rec', 'red'],
}

function FeatureCard({ feature, on, onChange }: { feature: (typeof FEATURES)[number]; on: boolean; onChange: (on: boolean) => void }) {
  const [icon, color] = ART[feature.id]
  if (!useHit(feature.label, feature.description, 'features plugins on off')) return null
  return (
    <button className={`fcard ${on ? 'on' : ''}`} role="switch" aria-checked={on} aria-label={feature.label} onClick={() => onChange(!on)} style={{ '--c': `var(--${color})` }}>
      <span className="art">
        <PIcon name={icon} />
      </span>
      <span className="fbody">
        <span className="fhead">
          <b>{feature.label}</b>
          <span className={`sw ${on ? 'on' : ''}`}>
            <i />
          </span>
        </span>
        <span className="sd">{feature.description}</span>
      </span>
    </button>
  )
}

function Features({ settings, update }: SectionProps) {
  return (
    <Group>
      <div className="fgrid">
        {FEATURES.map((f) => (
          <FeatureCard key={f.id} feature={f} on={settings.features[f.id]} onChange={(on) => update({ features: { [f.id]: on } })} />
        ))}
      </div>
    </Group>
  )
}

export const RELEASES = 'https://github.com/zaxovaiko/treeix/releases'

// The markdown stack loads when an update has notes to show, not at startup
const ReleaseNotes = lazy(() => import('./ReleaseNotes').then((m) => ({ default: m.ReleaseNotes })))

type UpdateState = { step: 'idle' } | { step: 'checking' } | { step: 'none' } | { step: 'ready'; info: UpdateInfo } | { step: 'installing' } | { step: 'error'; message: string }

function About({ view, settings, update }: SectionProps) {
  const [version] = useLoad(() => view.api.appVersion())
  const [state, setState] = useState<UpdateState>({ step: 'idle' })
  const check = () => {
    setState({ step: 'checking' })
    view.api.checkUpdate().then(
      (info) => setState(info ? { step: 'ready', info } : { step: 'none' }),
      (e: unknown) => setState({ step: 'error', message: message(e) })
    )
  }
  const install = () => {
    setState({ step: 'installing' })
    view.api.installUpdate().catch((e: unknown) => setState({ step: 'error', message: message(e) }))
  }
  return (
    <Group>
      <Row label={`Treeix ${version ?? ''}`} desc={state.step === 'ready' && state.info.notes ? <Suspense><ReleaseNotes view={view} notes={state.info.notes} /></Suspense> : 'Sessions keep running while it restarts'} keywords="version update">
        {state.step === 'checking' && <span className="dim">Checking...</span>}
        {state.step === 'installing' && <span className="dim">Installing...</span>}
        {state.step === 'none' && <span className="dim">Up to date</span>}
        {state.step === 'error' && <span className="st-err">{state.message}</span>}
        {state.step === 'ready' ? (
          <>
            <span className="ok">{state.info.version} is ready</span>
            <button className="btn sm pri" onClick={install}>
              Restart and install
            </button>
          </>
        ) : (
          state.step !== 'checking' &&
          state.step !== 'installing' && (
            <button className="btn sm" onClick={check}>
              Check for updates
            </button>
          )
        )}
        <button className="btn sm" onClick={() => void view.api.openUrl(RELEASES)}>
          Changelog
        </button>
      </Row>
      <Row label="Check for updates on start" keywords="update automatic">
        <Switch label="Check for updates on start" on={settings.updates.autoCheck} onChange={(autoCheck) => update({ updates: { autoCheck } })} />
      </Row>
    </Group>
  )
}

export const SECTION_VIEWS: Record<SettingsSection, (props: SectionProps) => ReactNode> = {
  appearance: Appearance,
  terminal: Terminal,
  keys: Keys,
  hotkey: Hotkey,
  agents: Agents,
  chats: Chats,
  usage: Usage,
  mcp: Mcp,
  jira: Jira,
  notion: Notion,
  prs: Prs,
  awake: Awake,
  routines: RoutinesSection,
  browser: BrowserSection,
  voice: VoiceSection,
  recording: RecordingSection,
  phone: Phone,
  features: Features,
  about: About,
}
