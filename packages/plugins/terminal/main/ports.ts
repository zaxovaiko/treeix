export type SessionPortEntry = { sessionId: string; port: number }
export type Listener = { pid: number; port: number }

/** `ps -A -o pid=,ppid=`: each pid's parent */
export function parseParents(ps: string): Map<number, number> {
  const parents = new Map<number, number>()
  for (const line of ps.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (match) parents.set(Number(match[1]), Number(match[2]))
  }
  return parents
}

/** `lsof -Fpn`: `p<pid>` starts a process, `n<address>:<port>` names each socket (`*:5173`, `127.0.0.1:3000`, `[::1]:8080`) */
export function parseListeners(lsof: string): Listener[] {
  const listeners: Listener[] = []
  let pid: number | null = null
  for (const line of lsof.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1)) || null
    const port = line.startsWith('n') ? /:(\d+)$/.exec(line)?.[1] : undefined
    if (pid !== null && port) listeners.push({ pid, port: Number(port) })
  }
  return listeners
}

/** A port belongs to the session whose shell is the listening process or one of its ancestors */
export function attributePorts(shells: Map<string, number>, parents: Map<number, number>, listeners: Listener[]): SessionPortEntry[] {
  const sessionOf = new Map([...shells].map(([sessionId, pid]) => [pid, sessionId]))
  const seen = new Set<string>()
  const found: SessionPortEntry[] = []
  for (const { pid, port } of listeners) {
    const visited = new Set<number>()
    let current: number | undefined = pid
    while (current !== undefined && current > 1 && !sessionOf.has(current) && !visited.has(current)) {
      visited.add(current)
      current = parents.get(current)
    }
    const sessionId = current === undefined ? undefined : sessionOf.get(current)
    if (!sessionId || seen.has(`${sessionId}:${port}`)) continue
    seen.add(`${sessionId}:${port}`)
    found.push({ sessionId, port })
  }
  return found
}
