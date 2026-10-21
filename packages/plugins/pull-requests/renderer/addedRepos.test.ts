import { expect, test } from 'bun:test'

test('repositories added to a project show in its worktrees too, and only there', async () => {
  const stored = new Map<string, string>()
  const original = globalThis.localStorage
  globalThis.localStorage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) } as unknown as Storage
  try {
    const { prRepoPaths, setAddedRepos } = await import('./addedRepos')
    setAddedRepos(['/p/betfeel/.claude/worktrees/chat-1'], ['/p/openora', '/p/betfeel'])
    expect(prRepoPaths(['/p/betfeel'])).toEqual(['/p/betfeel', '/p/openora'])
    expect(prRepoPaths(['/p/betfeel/.claude/worktrees/chat-2'])).toEqual(['/p/betfeel/.claude/worktrees/chat-2', '/p/openora'])
    expect(prRepoPaths(['/p/other'])).toEqual(['/p/other'])
    expect(prRepoPaths(null)).toBeNull()
  } finally {
    globalThis.localStorage = original
  }
})
