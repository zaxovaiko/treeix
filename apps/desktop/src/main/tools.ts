import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ToolStatus } from '../shared/types'
import type { ToolDefinition } from '@treeix/sdk/main'
import { withoutAgentVariables } from './env'

const exec = promisify(execFile)
const TIMEOUT_MS = 15_000

type Tool = ToolDefinition

const semver = (text: string): number[] | null => text.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number) ?? null

/** The latest version when it's newer than the installed one */
export function newerVersion(installed: string, latest: string): string | null {
  const [current, next] = [semver(installed), semver(latest)]
  if (!current || !next) return null
  const difference = next.map((part, index) => part - current[index]).find((delta) => delta !== 0) ?? 0
  return difference > 0 ? next.join('.') : null
}

/** Update checks are best effort: offline or rate-limited just shows no update */
async function latestRelease({ releases }: Tool): Promise<string> {
  if (!releases) return ''
  try {
    const response = await fetch(releases.url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    const body: unknown = await response.json()
    const value = typeof body === 'object' && body !== null ? Reflect.get(body, releases.field) : null
    return typeof value === 'string' ? value : ''
  } catch {
    return ''
  }
}

/** Same login shell as terminal sessions, so the result matches what sessions will find on PATH */
async function inLoginShell(command: string): Promise<{ output: string; failed: boolean }> {
  try {
    const { stdout, stderr } = await exec(process.env.SHELL ?? '/bin/zsh', ['-lc', command], {
      timeout: TIMEOUT_MS,
      env: withoutAgentVariables(process.env)
    })
    return { output: `${stdout}\n${stderr}`, failed: false }
  } catch (reason: unknown) {
    const stream = (key: 'stdout' | 'stderr'): string => (reason instanceof Error && key in reason ? String(Reflect.get(reason, key)) : '')
    return { output: `${stream('stdout')}\n${stream('stderr')}\n${String(reason)}`, failed: true }
  }
}

export const signedInAccounts = (output: string): string[] =>
  [...new Set([...output.matchAll(/Logged in to (\S+)(?: account| as)? (\S+)/g)].map(([, host, account]) => `${account} @ ${host}`))]

/** How the tool was installed decides how it updates: Homebrew, its own updater, else we don't guess */
export async function updateCommandFor(tool: Tool): Promise<string | null> {
  const installed = await inLoginShell(`brew list --formula ${tool.name}`)
  if (!installed.failed) return `brew upgrade ${tool.name}`
  return tool.selfUpdate ?? null
}

async function check(tool: Tool): Promise<ToolStatus> {
  const { name, purpose, auth } = tool
  const [version, latest] = await Promise.all([inLoginShell(`${name} --version`), latestRelease(tool)])
  if (version.failed) return { name, purpose, version: null, update: null, updateCommand: null, accounts: null, error: `${name} not found on PATH` }
  const versionLine = version.output.trim().split('\n')[0]
  const update = newerVersion(versionLine, latest)
  const updateCommand = update ? await updateCommandFor(tool) : null
  if (!auth) return { name, purpose, version: versionLine, update, updateCommand, accounts: null, error: null }
  const status = await inLoginShell(`${name} auth status`)
  const accounts = signedInAccounts(status.output)
  return { name, purpose, version: versionLine, update, updateCommand, accounts, error: accounts.length ? null : `Not signed in. Run \`${name} auth login\`` }
}

export const checkTools = (tools: Tool[]): Promise<ToolStatus[]> => Promise.all(tools.map(check))
