import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

/** Runs a command line the way the user's terminal would: their login shell, so PATH and sign-ins apply */
export function spawnInShell(command: string, cwd: string, env: Record<string, string>): ChildProcessWithoutNullStreams {
  const shell = process.env.SHELL || '/bin/zsh'
  return spawn(shell, ['-lc', command], { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
}
