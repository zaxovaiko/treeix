import { useEffect, useState } from 'react'
import { SETTINGS_NAV, sectionVisible, type SettingsSection } from '../../features'
import { useSettings } from '../../features/agents/settings'
import type { SettingsPatch } from '../../ipc/api'
import { Icon, type IconName } from '../../lib/icons'
import type { ShellView } from '../../shell/Shell'
import { Search } from './controls'
import { onSettingsSection, openableSection, takeRequestedSection } from './nav'
import { SECTION_VIEWS } from './sections'
import './settings.css'

export { useAppliedSettings } from './apply'
export { showSettingsSection } from './nav'

const SECTIONS: Record<SettingsSection, [label: string, icon: IconName]> = {
  appearance: ['Appearance', 'moon'],
  terminal: ['Terminal', 'terminal'],
  keys: ['Keyboard shortcuts', 'layout'],
  hotkey: ['Quick terminal', 'terminal'],
  agents: ['Agents', 'claude'],
  chats: ['Chats', 'codex'],
  usage: ['Usage', 'host'],
  mcp: ['MCP', 'split'],
  jira: ['Jira', 'book'],
  notion: ['Notion', 'book'],
  prs: ['Pull requests', 'branch'],
  awake: ['Keep awake', 'coffee'],
  routines: ['Routines', 'clock'],
  browser: ['Browser', 'globe'],
  voice: ['Dictation', 'mic'],
  recording: ['Meeting recording', 'rec'],
  features: ['Features', 'gear'],
  about: ['About', 'alert'],
}

/** Kept across openings of the page */
let last: SettingsSection = 'appearance'

/** Every setting, saved as it changes: settings.json through `updateSettings`, the look in the ui blob */
export function SettingsPage({ view, onClose }: { view: ShellView; onClose: () => void }) {
  const settings = useSettings(view.api)
  const [section, setSection] = useState<SettingsSection>(() => takeRequestedSection() ?? last)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => onSettingsSection((next) => (setSection(next), setQuery(''))), [])
  useEffect(() => {
    last = section
  }, [section])

  if (!settings) return null
  const update = (patch: SettingsPatch) =>
    view.api.updateSettings(patch).then(
      () => setError(null),
      (e: unknown) => setError(e instanceof Error ? e.message : String(e))
    )
  const shown = openableSection(section, settings.features)
  const visible = SETTINGS_NAV.map(([group, ids]) => [group, ids.filter((id) => sectionVisible(id, settings.features))] as const)
  const q = query.trim().toLowerCase()
  const props = { view, settings, update: (patch: SettingsPatch) => void update(patch) }
  const body = (id: SettingsSection) => {
    const View = SECTION_VIEWS[id]
    return <View {...props} />
  }

  return (
    <>
      <div className="gtop">
        <button className="btn sm" onClick={onClose}>
          <Icon name="left" />
          Terminal
        </button>
        <b>Settings</b>
        <span className="grow" />
        {error ? <span className="st-err trunc">{error}</span> : <span className="dim">Saved as you change them</span>}
      </div>
      <div className="setp">
        <nav className="snav">
          <div className="filter">
            <Icon name="search" />
            <input autoFocus placeholder="Search settings" value={query} spellCheck={false} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQuery('')} />
          </div>
          {visible.map(([group, ids]) => (
            <div key={group}>
              <div className="snav-g">{group}</div>
              {ids.map((id) => (
                <button key={id} className={`snav-i ${!q && id === shown ? 'on' : ''}`} onClick={() => (setSection(id), setQuery(''))}>
                  <Icon name={SECTIONS[id][1]} />
                  <span className="trunc">{SECTIONS[id][0]}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="scont" key={q ? 'search' : shown}>
          <div className="sinner">
            {q ? (
              <>
                {visible.flatMap(([, ids]) => ids).map((id) => (
                  <div key={id} className="shit">
                    <button className="sres" onClick={() => (setSection(id), setQuery(''))}>
                      <Icon name={SECTIONS[id][1]} />
                      {SECTIONS[id][0]}
                    </button>
                    <Search value={{ query: q, section: SECTIONS[id][0], group: '' }}>{body(id)}</Search>
                  </div>
                ))}
                <div className="empty snone">No settings match “{query.trim()}”</div>
              </>
            ) : (
              <>
                <h1 className="sh1">
                  <Icon name={SECTIONS[shown][1]} />
                  {SECTIONS[shown][0]}
                </h1>
                {body(shown)}
              </>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
