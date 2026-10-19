import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { userShell, withoutAgentVariables } from '@treeix/host/env'

const KILL_GRACE_MS = 3000

/** Runs a command line the way the user's terminal would: their login shell, so PATH and sign-ins apply. Detached, so its process group can be killed as one */
export function spawnInShell(command: string, cwd: string, env: Record<string, string>): ChildProcessWithoutNullStreams {
  // spawn blames the shell for a missing cwd, so a deleted worktree reads as `spawn /bin/zsh ENOENT`
  if (!existsSync(cwd)) throw new Error(`${cwd} is gone`)
  const shell = userShell()
  return spawn(shell, ['-lc', command], { cwd, env: { ...withoutAgentVariables(process.env), ...env }, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
}

function signalGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    // The group is already gone
  }
}

/** Ends stdin, SIGTERMs the shell's process group, then SIGKILLs whatever of it outlives the grace period */
export function killGroup(child: ChildProcessWithoutNullStreams) {
  child.stdin.end()
  signalGroup(child, 'SIGTERM')
  setTimeout(() => signalGroup(child, 'SIGKILL'), KILL_GRACE_MS).unref()
}

const OUTPUT_LIMIT = 30_000
const SHELL_TIMEOUT_MS = 120_000

const capped = (text: string): string => (text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n… cut at ${OUTPUT_LIMIT} characters` : text)

/** Runs a command the user typed to completion, no input; one still going after two minutes is killed */
export function runInShell(command: string, cwd: string, env: Record<string, string>): Promise<{ stdout: string; stderr: string }> {
  const child = spawnInShell(command, cwd, env)
  child.stdin.end()
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
  const timer = setTimeout(() => {
    stderr += `\nStopped after ${SHELL_TIMEOUT_MS / 1000}s`
    killGroup(child)
  }, SHELL_TIMEOUT_MS)
  return new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout: capped(stdout), stderr: capped(code ? `${stderr}${stderr ? '\n' : ''}Exit code ${code}` : stderr) })
    })
  })
}
