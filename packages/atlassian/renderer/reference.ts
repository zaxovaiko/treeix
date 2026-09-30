import type { HostApi } from '@treeix/sdk'
import { baseName } from '@treeix/app/Sidebar'

/** An Atlassian item in the agent comments as a reference the agent opens with acli; `body` rides along for machines without it */
export function addReference(host: HostApi, worktreePath: string, reference: { filePath: string; text: string; body: string }, added: string): void {
  host.addComment({ id: crypto.randomUUID(), worktreePath, range: { start: 0, end: 0 }, code: '', tool: 'acli', kind: 'reference', ...reference })
  host.flash(`Added ${added} to comments on ${baseName(worktreePath)}`)
}
