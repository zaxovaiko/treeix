import { access, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { BrowserProfile } from '../../shared/types'

const SUPPORT = join(homedir(), 'Library', 'Application Support')

const CHROMIUM = [
  { browser: 'Chrome', dir: 'Google/Chrome', keychain: 'Chrome Safe Storage' },
  { browser: 'Arc', dir: 'Arc/User Data', keychain: 'Arc Safe Storage' },
  { browser: 'Brave', dir: 'BraveSoftware/Brave-Browser', keychain: 'Brave Safe Storage' },
  { browser: 'Edge', dir: 'Microsoft Edge', keychain: 'Microsoft Edge Safe Storage' },
  { browser: 'Chromium', dir: 'Chromium', keychain: 'Chromium Safe Storage' },
  { browser: 'Vivaldi', dir: 'Vivaldi', keychain: 'Vivaldi Safe Storage' }
] as const

/** `folder` is the profile's folder, the stable part of its key; `name` is what the browser shows */
export type ProfileSource =
  | { kind: 'chromium'; browser: string; folder: string; name: string; cookiesPath: string; keychain: string }
  | { kind: 'firefox'; browser: 'Firefox'; folder: string; name: string; cookiesPath: string }

type Entry = ProfileSource | BrowserProfile

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false)
export const isBlocked = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'EPERM'
const blockedBrowser = (browser: string): BrowserProfile => ({ key: `${browser}:`, browser, name: 'All profiles', blocked: true })

async function firstExisting(paths: string[]): Promise<string | null> {
  for (const path of paths) if (await exists(path)) return path
  return null
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** Folder to display name, from Local State's `profile.info_cache` */
function profileNames(localState: unknown): Record<string, string> {
  const cache = isRecord(localState) && isRecord(localState.profile) ? localState.profile.info_cache : undefined
  if (!isRecord(cache)) return {}
  return Object.fromEntries(Object.entries(cache).map(([folder, info]) => [folder, isRecord(info) && typeof info.name === 'string' ? info.name : folder]))
}

async function chromiumSources(): Promise<Entry[]> {
  const found: Entry[] = []
  for (const { browser, dir, keychain } of CHROMIUM) {
    const root = join(SUPPORT, dir)
    let names: Record<string, string>
    try {
      names = profileNames(JSON.parse(await readFile(join(root, 'Local State'), 'utf8')))
    } catch (error) {
      if (isBlocked(error)) found.push(blockedBrowser(browser))
      continue
    }
    for (const [folder, name] of Object.entries(names)) {
      const cookiesPath = await firstExisting([join(root, folder, 'Network', 'Cookies'), join(root, folder, 'Cookies')])
      if (cookiesPath) found.push({ kind: 'chromium', browser, folder, name, cookiesPath, keychain })
    }
  }
  return found
}

async function firefoxSources(): Promise<Entry[]> {
  const root = join(SUPPORT, 'Firefox')
  let ini: string
  try {
    ini = await readFile(join(root, 'profiles.ini'), 'utf8')
  } catch (error) {
    return isBlocked(error) ? [blockedBrowser('Firefox')] : []
  }
  const sections = ini.split(/^\[/m).filter((section) => section.startsWith('Profile'))
  const found: Entry[] = []
  for (const section of sections) {
    const field = (name: string): string => section.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim() ?? ''
    const folder = field('Path')
    if (!folder) continue
    const cookiesPath = join(field('IsRelative') === '1' ? join(root, folder) : folder, 'cookies.sqlite')
    if (await exists(cookiesPath)) found.push({ kind: 'firefox', browser: 'Firefox', folder, name: field('Name') || folder, cookiesPath })
  }
  return found
}

const isSource = (entry: Entry): entry is ProfileSource => 'cookiesPath' in entry
const keyOf = (source: ProfileSource): string => `${source.browser}:${source.folder}`

const allEntries = async (): Promise<Entry[]> => [...(await chromiumSources()), ...(await firefoxSources())]

/** Installed browsers and their profiles; a browser macOS won't let us read shows up once, blocked */
export async function listProfiles(): Promise<BrowserProfile[]> {
  return (await allEntries()).map((entry) => (isSource(entry) ? { key: keyOf(entry), browser: entry.browser, name: entry.name, blocked: false } : entry))
}

export async function profileSource(key: string): Promise<ProfileSource | null> {
  return (await allEntries()).filter(isSource).find((source) => keyOf(source) === key) ?? null
}
