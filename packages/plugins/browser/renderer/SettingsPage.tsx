import { useEffect, useState } from 'react'
import { createBridge } from '@treeix/sdk'
import { Card, Row, Segmented, Switch } from '@treeix/app/settingsUi'
import type { BrowserProfile, ImportInfo, ImportResult } from '../shared/types'
import type { SearchEngine } from './address'
import { browserSettings } from './settings'

const bridge = createBridge('browser')

export const importLabel = (info: ImportInfo): string => (info ? `${info.browser}, ${new Date(info.at).toLocaleDateString()}` : 'None')

export function BrowserSettings(): React.JSX.Element {
  const { openLinks, searchEngine } = browserSettings.use()
  const [canImport, setCanImport] = useState(false)
  const [profiles, setProfiles] = useState<BrowserProfile[]>([])
  const [chosen, setChosen] = useState('')
  const [info, setInfo] = useState<ImportInfo>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  useEffect(() => {
    void bridge.invoke<boolean>('canImport').then(setCanImport)
    void bridge.invoke<ImportInfo>('importInfo').then(setInfo)
  }, [])
  useEffect(() => {
    if (!canImport) return
    void bridge.invoke<BrowserProfile[]>('profiles').then((list) => {
      setProfiles(list)
      setChosen((current) => current || (list.find((profile) => !profile.blocked)?.key ?? ''))
    })
  }, [canImport])
  const chosenProfile = profiles.find((profile) => profile.key === chosen)
  const runImport = async (): Promise<void> => {
    setBusy(true)
    try {
      if (chosenProfile?.blocked) {
        const list = await bridge.invoke<BrowserProfile[]>('profiles')
        setProfiles(list)
        const unblocked = list.find((profile) => !profile.blocked && profile.browser === chosenProfile.browser)
        if (unblocked) setChosen(unblocked.key)
        return
      }
      setResult(null)
      const outcome = await bridge.invoke<ImportResult>('import', chosen)
      setResult(outcome.error ?? `Imported ${outcome.imported.toLocaleString()} cookies${outcome.skipped ? `, skipped ${outcome.skipped.toLocaleString()}` : ''}`)
      setInfo(await bridge.invoke<ImportInfo>('importInfo'))
    } catch {
      setResult('Import failed. Try again')
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Card title="Browser">
        <Row label="Open links from terminals here" description="⌘-click on a URL in a session opens it in the Browser tab instead of your default browser">
          <Switch checked={openLinks} label="Open links from terminals here" onChange={() => browserSettings.update({ openLinks: !openLinks })} />
        </Row>
        <Row label="Search engine" description="What the address bar searches when you type words instead of an address">
          <Segmented<SearchEngine>
            value={searchEngine}
            options={[
              ['google', 'Google'],
              ['duckduckgo', 'DuckDuckGo'],
              ['bing', 'Bing']
            ]}
            onChange={(engine) => browserSettings.update({ searchEngine: engine })}
          />
        </Row>
        <Row label="Clear browsing data" description="Signs you out of every site in the built-in browser and empties its cache">
          <button
            className="h-7 rounded-md border border-border px-2.5 text-xs hover:bg-accent"
            onClick={() =>
              void bridge.invoke('clearData').then(() => {
                setInfo(null)
                setResult('Browsing data cleared')
              })
            }
          >
            Clear
          </button>
        </Row>
      </Card>
      {canImport && (
        <Card title="Cookies">
          <Row
            label="Import from another browser"
            description={`A one-off copy of your sign-ins, so sites open signed in. macOS will ask for access to the browser's key. Click Allow, not Always Allow. Last import: ${importLabel(info)}`}
          >
            <div className="flex items-center gap-2">
              <select value={chosen} onChange={(event) => setChosen(event.target.value)} className="h-7 rounded-md border border-border bg-background px-2 text-xs">
                {profiles.length === 0 && <option value="">No browsers found</option>}
                {profiles.map((profile) => (
                  <option key={profile.key} value={profile.key}>
                    {profile.browser}, {profile.name}
                    {profile.blocked ? ' (needs access)' : ''}
                  </option>
                ))}
              </select>
              <button disabled={!chosen || busy} onClick={() => void runImport()} className="h-7 rounded-md border border-border px-2.5 text-xs hover:bg-accent disabled:opacity-50">
                {busy ? (chosenProfile?.blocked ? 'Checking…' : 'Importing…') : chosenProfile?.blocked ? 'Check again' : info ? 'Import again' : 'Import'}
              </button>
            </div>
          </Row>
          {(result || chosenProfile?.blocked) && (
            <div className="px-4 py-2 text-xs text-muted-foreground">
              {result ?? `macOS blocks reading ${chosenProfile?.browser}. Allow Treeix to access data from other apps in System Settings > Privacy & Security, then import again`}
            </div>
          )}
        </Card>
      )}
    </>
  )
}
