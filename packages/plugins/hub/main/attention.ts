import type { Run } from '../shared/workflow'

/** What someone away from the screen cares about: a step started waiting for them, or a run ended */
export type Attention = { kind: 'waiting'; run: Run; node: string } | { kind: 'ended'; run: Run }

/**
 * Turns every saved run into attention moments, each told once, and says whether any run is still going.
 * A step that waits again later (a second permission question) is told again.
 */
export function createAttention(notify: (attention: Attention) => void, busy: (busy: boolean) => void): (run: Run) => void {
  const going = new Map<string, Set<string>>()
  let wasBusy = false
  return (run) => {
    const before = going.get(run.id)
    const waiting = new Set(run.status === 'running' ? Object.keys(run.nodes).filter((id) => run.nodes[id].waiting) : [])
    if (run.status === 'running') going.set(run.id, waiting)
    else going.delete(run.id)
    for (const node of waiting) if (!before?.has(node)) notify({ kind: 'waiting', run, node })
    if (before && run.status !== 'running') notify({ kind: 'ended', run })
    if (going.size > 0 !== wasBusy) busy((wasBusy = going.size > 0))
  }
}
