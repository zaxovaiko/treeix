import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { type Credentials, isJson, text } from '../shared'

const exec = promisify(execFile)
const TIMEOUT_MS = 60_000

export const failure = (reason: unknown): string => {
  const stderr = isJson(reason) ? text(reason.stderr).trim() : ''
  if (isJson(reason) && reason.code === 'ENOENT') return 'Atlassian CLI not found. Install it with: brew tap atlassian/homebrew-acli && brew install acli'
  return (stderr || (reason instanceof Error ? reason.message : String(reason))).split('\n')[0]
}

export const run = async (args: string[]): Promise<string> => (await exec('acli', args, { timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 })).stdout

/** acli with --json output parsed; rejects with acli's own message */
export const acli = (args: string[]): Promise<unknown> =>
  run(args).then(
    (stdout) => JSON.parse(stdout),
    (reason: unknown) => {
      throw new Error(failure(reason))
    }
  )

/** The signed-in site from `acli jira auth status`, e.g. team.atlassian.net; JSON from acli only links internal hosts */
export const parseSite = (status: string): string | null => status.match(/Site:\s*(\S+)/)?.[1] ?? null
export const parseEmail = (status: string): string | null => status.match(/Email:\s*(\S+)/)?.[1] ?? null

let site: Promise<string | null> | null = null
export const atlassianSite = (): Promise<string | null> => {
  site ??= run(['jira', 'auth', 'status']).then(parseSite, () => {
    site = null
    return null
  })
  return site
}
export const signedInEmail = (): Promise<string | null> => run(['jira', 'auth', 'status']).then(parseEmail, () => null)

/** REST call for what acli can't do (search, attachments); needs the API token */
export async function restFetch(path: string, credentials: Credentials | null): Promise<Response> {
  if (!credentials) throw new Error('Needs an Atlassian API token. Add one in Settings → Plugins.')
  const host = await atlassianSite()
  if (!host) throw new Error('Sign in with acli jira auth login --web first')
  const response = await fetch(`https://${host}${path}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${credentials.email}:${credentials.token}`).toString('base64')}`, Accept: 'application/json, */*' }
  })
  if (response.status === 401 || response.status === 403) throw new Error('Atlassian refused the API token. Check it in Settings → Plugins.')
  if (!response.ok) throw new Error(`Atlassian answered ${response.status}`)
  return response
}
