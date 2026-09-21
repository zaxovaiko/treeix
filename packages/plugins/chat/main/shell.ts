import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { withoutAgentVariables } from '@treeix/host/env'

const KILL_GRACE_MS = 3000

/** Runs a command line the way the user's terminal would: their login shell, so PATH and sign-ins apply. Detached, so its process group can be killed as one */
export function spawnInShell(command: string, cwd: string, env: Record<string, string>): ChildProcessWithoutNullStreams {
  const shell = process.env.SHELL || '/bin/zsh'
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
