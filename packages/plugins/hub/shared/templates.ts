import { MAX_TIMEOUT_MIN } from './types'
import { MAX_SCORE, WATCH_QUERY, type Watch, type Workflow, type WorkflowNode } from './workflow'

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

const ITEM: Record<Watch['source'], string> = { jira: 'Jira ticket', notion: 'Notion task' }

const planPrompt = (source: Watch['source']): string => `You plan one ${ITEM[source]} before anyone builds it. Change nothing yet: no files, branches or comments.

Item: {{input.key}} {{input.title}}
Link: {{input.url}}

1. Read it in full with the ${TOOLS[source].read} tool (Treeix), with its comments and linked docs, and the code it touches. Follow the repo's AGENTS.md or CLAUDE.md.
2. Reply with the plan: what changes where, how it gets tested, and what is left out. Short and in plain words: people read it on the item and comment on it.
3. If it is unclear what to build, or it needs a decision only a person can make, put the questions first.`

const shipPrompt = (source: Watch['source']): string => {
  const tools = TOOLS[source]
  return `You take one ${ITEM[source]} to a pull request, on your own: nobody watches this run.

Item: {{input.key}} {{input.title}}
Link: {{input.url}}

The approved plan, with the notes it was approved with:
{{prev}}

1. Read it in full with the ${tools.read} tool (Treeix), with its comments and linked docs. Build what the plan says, taking every note and comment into account.
2. Find the repo it belongs to: this folder, or the one under it the item names. Follow that repo's AGENTS.md or CLAUDE.md, its skills and its subagents.
3. If it is unclear what to build, or it needs a decision only a person can make: ask in one ${tools.comment} comment, then ${tools.unmark} and stop. Say "Asked: " and the questions as your reply.
4. Pull the target branch, then work in a new git worktree off it, on a branch named after {{input.key}}. Leave the user's checkout alone.
5. A bug: reproduce it first. Then make the change, with a test where the repo has them.
6. Run the repo's CI commands until they pass. A visible change: take screenshots of each changed screen (both themes if it has them) and a short video of the flow.
7. Push the branch and open a pull request (or merge request) with the screenshots and video in it. No AI attribution anywhere: no Co-Authored-By, no "Generated with" line.
8. Comment the link on the item with ${tools.comment}, ${tools.handOff}, and ${tools.unmark}.

End your reply with the pull request URL on its own line.`
}

const shipRubric = (source: Watch['source']): string => `The work is a pull request for {{input.key}} {{input.title}} ({{input.url}}), or questions asked on the item instead.

1. Read the item in full with the ${TOOLS[source].read} tool (Treeix), and the pull request with its diff.
2. Every acceptance criterion is met; it follows the approved plan and its notes ({{nodes.approve.output}}); a bug has a test that fails without the fix; nothing outside the item changed; a visible change has screenshots in the pull request; no AI attribution in commits or the pull request.
3. In a git worktree of the branch, run the repo's CI commands. Any failure is an issue.

If the agent asked questions instead: score ${MAX_SCORE} when only a person could answer them, 1 when the item was clear enough to build.`

const NAME: Record<Watch['source'], string> = { jira: 'Ship Jira tickets', notion: 'Ship Notion tasks' }

/** Steps in a row, each feeding the next */
const chain = (name: string, nodes: WorkflowNode[]): Workflow => ({
  id: crypto.randomUUID(),
  name,
  nodes,
  edges: nodes.slice(1).map((node, index) => ({ id: `${nodes[index].id}-${node.id}`, from: nodes[index].id, to: node.id, branch: null })),
  layout: Object.fromEntries(nodes.map((node, index) => [node.id, { x: index * 260, y: 0 }])),
  updatedAt: Date.now()
})

const agentStep = (id: string, agent: string, prompt: string): WorkflowNode => ({
  id,
  kind: 'agent',
  agent,
  prompt,
  folder: null,
  retries: 0,
  onError: 'stop',
  timeoutMin: MAX_TIMEOUT_MIN
})

/** One agent step with the prompt and a review that sends it back twice at most, then the output */
const reviewed = (agent: string, prompt: string, rubric: string): WorkflowNode[] => [
  agentStep('agent', agent, prompt),
  { id: 'review', kind: 'judge', agent, source: '{{prev}}', rubric, minScore: 8, retryStep: 'agent', rounds: 2, onError: 'stop' },
  { id: 'output', kind: 'output', template: '{{prev}}' }
]

/**
 * A workflow that watches Jira or Notion and has an agent take each new item to a pull request, after its plan is approved on
 * the item or in Treeix: changes asked for there send the plan back. Its watch starts off, so nothing runs before the agent and folder are checked
 */
export const shipWorkflow = (source: Watch['source'], agent: string): Workflow =>
  chain(NAME[source], [
    {
      id: 'input',
      kind: 'input',
      watches: [{ id: crypto.randomUUID(), source, query: WATCH_QUERY[source], ...(source === 'notion' && { dataSource: '' }), enabled: false }]
    },
    agentStep('plan', agent, planPrompt(source)),
    { id: 'approve', kind: 'approval', message: 'The plan for {{input.key}} {{input.title}}:\n\n{{prev}}', retryStep: 'plan' },
    ...reviewed(agent, shipPrompt(source), shipRubric(source))
  ])

const ADD_TESTS_PROMPT = `You work on one pull request, on your own: nobody watches this run.

Pull request: {{input.url}} {{input.title}}
Branch: {{input.sourceBranch}}, into {{input.targetBranch}}

1. Fetch, then work in a git worktree on {{input.sourceBranch}}: reuse one that already has it, else add one. Leave the user's checkout alone.
2. Follow the repo's AGENTS.md or CLAUDE.md, its skills and its subagents.
3. Read what the pull request changes against {{input.targetBranch}} and add tests that cover it, in the style of the repo's own. If the repo has no tests, say so and stop.
4. Run the repo's CI commands until they pass.
5. Commit and push to {{input.sourceBranch}}. Never force-push, merge or approve. No AI attribution anywhere: no Co-Authored-By, no "Generated with" line.

End your reply with what the new tests cover, in one line.`

const ADD_TESTS_RUBRIC = `The work is new tests pushed to {{input.sourceBranch}} of {{input.url}}.

1. Read what the pull request changes against {{input.targetBranch}}, and the new tests.
2. The tests cover what it changes, failure paths and edge cases included; they check behaviour, not implementation details; they follow the repo's own test style; nothing else changed.
3. In a git worktree of {{input.sourceBranch}}, run the repo's CI commands. Any failure is an issue.

If the agent said the repo has no tests: score ${MAX_SCORE} when that is true, 1 when it is not.`

/** A board stage: a pull request dropped on it gets tests for what it changes */
export const addTestsWorkflow = (agent: string): Workflow => chain('Add tests', [{ id: 'input', kind: 'input' }, ...reviewed(agent, ADD_TESTS_PROMPT, ADD_TESTS_RUBRIC)])
