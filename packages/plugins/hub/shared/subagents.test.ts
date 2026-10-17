import { expect, test } from 'bun:test'
import { parseSubagent, subagentBody } from './subagents'

const claude = `---
name: quality-reviewer
description: >-
  Code-quality review of changed files: boundaries, conventions,
  performance. Findings only, no edits.
model: sonnet
---
You are a senior code-quality reviewer.
`

const rulesync = `---
targets:
  - '*'
name: builder
description: Senior fullstack engineer.
claudecode:
  model: opus
---
Body.
`

test('reads a Claude subagent', () => {
  expect(parseSubagent('/repo', '/repo/.claude/agents/quality-reviewer.md', claude)).toEqual({
    name: 'quality-reviewer',
    description: 'Code-quality review of changed files: boundaries, conventions, performance. Findings only, no edits.',
    model: 'sonnet',
    folder: '/repo',
    path: '/repo/.claude/agents/quality-reviewer.md'
  })
})

test("reads rulesync's model from its Claude Code target", () => {
  const parsed = parseSubagent('/repo', '/repo/.rulesync/subagents/builder.md', rulesync)
  expect(parsed?.name).toBe('builder')
  expect(parsed?.model).toBe('opus')
})

test('reads a Codex subagent, and falls back to the file name', () => {
  const parsed = parseSubagent('/repo', '/repo/.codex/agents/qa.toml', "description = \"Verifies a change by hand.\"\ndeveloper_instructions = '''\nBody\n'''\n")
  expect(parsed).toEqual({ name: 'qa', description: 'Verifies a change by hand.', model: null, folder: '/repo', path: '/repo/.codex/agents/qa.toml' })
})

test('a subagent body drops the frontmatter, and a Codex file its key lines', () => {
  expect(subagentBody('/repo/.claude/agents/review.md', '---\nname: Reviewer\nmodel: sonnet\n---\n\nFind bugs.\nNothing else.\n')).toBe('Find bugs.\nNothing else.')
  expect(subagentBody('/repo/.codex/agents/review.toml', 'name = "Reviewer"\nmodel = "sonnet"\ninstructions = """\nFind bugs.\n"""\n')).toBe('Find bugs.')
})
