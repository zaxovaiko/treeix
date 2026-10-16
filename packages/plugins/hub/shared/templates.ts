import { MAX_TIMEOUT_MIN } from './types'
import { WATCH_QUERY, type Watch, type Workflow } from './workflow'

/** How the agent reads, answers and hands back each kind of item, through the Treeix tools */
const TOOLS: Record<Watch['source'], { read: string; comment: string; unmark: string; handOff: string }> = {
  jira: { read: 'jira_work_item', comment: 'jira_comment', unmark: 'remove the agent-ready label with jira_edit_labels', handOff: 'move it to Code Review with jira_transition' },
  notion: {
    read: 'notion_page',
    comment: 'notion_comment',
    unmark: 'clear its Agent property with notion_update_page',
    handOff: 'set its Status to In review with notion_update_page, if it has one'
  }
}

const shipPrompt = (source: Watch['source']): string => {
  const tools = TOOLS[source]
  return `You take one ${source === 'jira' ? 'Jira ticket' : 'Notion task'} to a pull request, on your own: nobody watches this run.

Item: {{input.key}} {{input.title}}
Link: {{input.url}}

1. Read it in full with the ${tools.read} tool (Treeix), with its comments and linked docs.
2. Find the repo it belongs to: this folder, or the one under it the item names. Follow that repo's AGENTS.md or CLAUDE.md, its skills and its subagents.
3. If it is unclear what to build, or it needs a decision only a person can make: ask in one ${tools.comment} comment, then ${tools.unmark} and stop. Say "Asked: " and the questions as your reply.
4. Pull the target branch, then work in a new git worktree off it, on a branch named after {{input.key}}. Leave the user's checkout alone.
5. A bug: reproduce it first. Then make the change, with a test where the repo has them.
6. Run the repo's CI commands until they pass. A visible change: take screenshots of each changed screen (both themes if it has them) and a short video of the flow.
7. Push the branch and open a pull request (or merge request) with the screenshots and video in it. No AI attribution anywhere: no Co-Authored-By, no "Generated with" line.
8. Comment the link on the item with ${tools.comment}, ${tools.handOff}, and ${tools.unmark}.

End your reply with the pull request URL on its own line.`
}

const NAME: Record<Watch['source'], string> = { jira: 'Ship Jira tickets', notion: 'Ship Notion tasks' }

/** Input, one agent step with the prompt, output */
const oneStep = (name: string, agent: string, prompt: string, input: Extract<Workflow['nodes'][number], { kind: 'input' }>): Workflow => ({
  id: crypto.randomUUID(),
  name,
  nodes: [
    input,
    { id: 'agent', kind: 'agent', agent, prompt, folder: null, retries: 0, onError: 'stop', timeoutMin: MAX_TIMEOUT_MIN },
    { id: 'output', kind: 'output', template: '{{prev}}' }
  ],
  edges: [
    { id: 'input-agent', from: 'input', to: 'agent', branch: null },
    { id: 'agent-output', from: 'agent', to: 'output', branch: null }
  ],
  layout: { input: { x: 0, y: 0 }, agent: { x: 260, y: 0 }, output: { x: 520, y: 0 } },
  updatedAt: Date.now()
})

/** A workflow that watches Jira or Notion and has an agent take each new item to a pull request; its watch starts off, so nothing runs before the agent and folder are checked */
export const shipWorkflow = (source: Watch['source'], agent: string): Workflow =>
  oneStep(NAME[source], agent, shipPrompt(source), {
    id: 'input',
    kind: 'input',
    watches: [{ id: crypto.randomUUID(), source, query: WATCH_QUERY[source], ...(source === 'notion' && { dataSource: '' }), enabled: false }]
  })

const ADD_TESTS_PROMPT = `You work on one pull request, on your own: nobody watches this run.

Pull request: {{input.url}} {{input.title}}
Branch: {{input.sourceBranch}}, into {{input.targetBranch}}

1. Fetch, then work in a git worktree on {{input.sourceBranch}}: reuse one that already has it, else add one. Leave the user's checkout alone.
2. Follow the repo's AGENTS.md or CLAUDE.md, its skills and its subagents.
3. Read what the pull request changes against {{input.targetBranch}} and add tests that cover it, in the style of the repo's own. If the repo has no tests, say so and stop.
4. Run the repo's CI commands until they pass.
5. Commit and push to {{input.sourceBranch}}. Never force-push, merge or approve. No AI attribution anywhere: no Co-Authored-By, no "Generated with" line.

End your reply with what the new tests cover, in one line.`

/** A board stage: a pull request dropped on it gets tests for what it changes */
export const addTestsWorkflow = (agent: string): Workflow => oneStep('Add tests', agent, ADD_TESTS_PROMPT, { id: 'input', kind: 'input' })
