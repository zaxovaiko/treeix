import { MAX_TIMEOUT_MIN } from './types'
import { WATCH_QUERY, type Watch, type Workflow, type WorkflowNode } from './workflow'

/** How the agent reads, answers, tracks and hands back each kind of item, through the Treeix tools */
const TOOLS: Record<Watch['source'], { read: string; comment: string; start: string; track: string; unmark: string; handOff: string }> = {
  jira: {
    read: 'jira_work_item',
    comment: 'jira_comment',
    start: 'move it to In Progress with jira_transition',
    track: "tick its items in the Plan comment: jira_comment with that comment's id, found in jira_work_item",
    unmark: 'remove the agent-ready label with jira_edit_labels',
    handOff: 'move it to Code Review with jira_transition'
  },
  notion: {
    read: 'notion_page',
    comment: 'notion_comment',
    start: 'set its Status to In progress with notion_update_page, if it has one',
    track: 'add one short notion_comment with the Plan items done so far',
    unmark: 'clear its Agent property with notion_update_page',
    handOff: 'set its Status to In review with notion_update_page, if it has one'
  }
}

const ITEM: Record<Watch['source'], string> = { jira: 'Jira ticket', notion: 'Notion task' }

const ON_YOUR_OWN = 'on your own: nobody watches this run'
const NO_ATTRIBUTION = 'No AI attribution anywhere: no Co-Authored-By, no "Generated with" line'
const WORKTREE = `Worktree and branch, from the implement step:
{{nodes.implement.output}}`

/** An agent replying with this, on its own line, stops the ticket for a person; the board shows it as Needs you */
export const STOP = { asked: 'Asked:', blocked: 'Blocked:' } as const

const planPrompt = (source: Watch['source']): string => {
  const tools = TOOLS[source]
  return `You plan one ${ITEM[source]}, ${ON_YOUR_OWN}. Change no code yet.

Item: {{input.key}} {{input.title}}
Link: {{input.url}}

1. ${tools.start[0].toUpperCase()}${tools.start.slice(1)}.
2. Read it in full with the ${tools.read} tool (Treeix), with its comments, tech notes and linked docs, and the code it touches. Follow the repo's AGENTS.md or CLAUDE.md.
3. If it is unclear what to build, or it needs a decision only a person can make: ask in one ${tools.comment} comment, then ${tools.unmark}, and reply only "${STOP.asked} " and the questions.
4. Otherwise post one ${tools.comment} comment titled "Plan": a "- [ ]" checklist of what changes where, how it gets tested, and what is left out. Short and in plain words.

Reply with the plan as posted.`
}

const implementPrompt = (source: Watch['source']): string => `You build one ${ITEM[source]}, ${ON_YOUR_OWN}.

Item: {{input.key}} {{input.title}}
Link: {{input.url}}

The plan, posted on the item:
{{nodes.plan.output}}

1. Read the item again with the ${TOOLS[source].read} tool (Treeix): comments added since the plan count too.
2. Find the repo it belongs to: this folder, or the one under it the item names. Follow that repo's AGENTS.md or CLAUDE.md, its skills and its subagents.
3. Pull the target branch, then work in a new git worktree off it, on a branch named after {{input.key}}. Leave the user's checkout alone.
4. A bug: reproduce it first. Then make the change, with tests where the repo has them.
5. Run the repo's CI commands until they pass. Commit with the repo's commit style. ${NO_ATTRIBUTION}.
6. As each part of the plan is done, ${TOOLS[source].track}.
7. If you can't finish it: say why in one ${TOOLS[source].comment} comment, and reply only "${STOP.blocked} " and the reason.

End your reply with two lines: "Worktree: <its absolute path>" and "Branch: <its name>".`

const qaPrompt = (source: Watch['source']): string => `You test one ${ITEM[source]} for real before anyone reviews it, ${ON_YOUR_OWN}.

Item: {{input.key}} {{input.title}}
Link: {{input.url}}

${WORKTREE}

1. Read the item with the ${TOOLS[source].read} tool (Treeix) and list every acceptance criterion, including the ones its plan and comments add.
2. Verify each one the way a user meets it, in the worktree: run the app and drive it end to end (a browser for web, a simulator for mobile), call the API, or check the real systems with their CLI tools (aws, sentry, and the like). Check every detail, not just the happy path.
3. Save proof of each into the worktree's proof/ folder: screenshots of each changed screen (both themes if it has them), a short video of the flow, command output.
4. Something fails: fix it in the worktree, run the repo's CI commands, commit, and verify again.
5. If something can't be verified or keeps failing: say what in one ${TOOLS[source].comment} comment, and reply only "${STOP.blocked} " and what.

Reply with each criterion and how it was verified, one per line, then the proof files.`

const prPrompt = (source: Watch['source']): string => {
  const tools = TOOLS[source]
  return `You open the pull request for one ${ITEM[source]}, ${ON_YOUR_OWN}.

Item: {{input.key}} {{input.title}}
Link: {{input.url}}

${WORKTREE}

What QA verified:
{{nodes.qa.output}}

1. Follow the repo's AGENTS.md or CLAUDE.md for branches and pull requests.
2. Commit the proof/ files to the branch, push it, and open a pull request (or merge request) that links the item, says what changed and how it was tested, and embeds the screenshots and video from the pushed branch. ${NO_ATTRIBUTION}.
3. Comment the link on the item with ${tools.comment}, ${tools.handOff}, and ${tools.unmark}.

End your reply with "PR: " and the pull request URL on its own line.`
}

const FIX_PROMPT = `You keep one pull request green, ${ON_YOUR_OWN}.

Item: {{input.key}}
Pull request: {{input.url}}
Branch: {{input.sourceBranch}}

What to fix:
{{input.details}}

1. Fetch, then work in a git worktree on {{input.sourceBranch}}: reuse one that already has it, else add one. Leave the user's checkout alone.
2. Follow the repo's AGENTS.md or CLAUDE.md, its skills and its subagents.
3. Failed CI: reproduce the failure locally and fix its cause; never skip or loosen a test to make it pass. Review comments: do what each asks; one that is wrong or unclear gets no code change, only an answer.
4. Run the repo's CI commands until they pass, then commit and push to {{input.sourceBranch}}. Never force-push, merge, approve or resolve a thread. ${NO_ATTRIBUTION}.
5. Review comments: reply to each one on the pull request with gh or glab, starting the reply with "Agent:", saying what changed or why not.

End your reply with what you changed, in one line.`

const NAME: Record<Watch['source'], string> = { jira: 'Ship Jira tickets', notion: 'Ship Notion tasks' }

/** Steps in a row, each feeding the next; a condition in the row ends the run when it holds */
const chain = (name: string, nodes: WorkflowNode[]): Workflow => ({
  id: crypto.randomUUID(),
  name,
  nodes,
  edges: nodes
    .slice(1)
    .map((node, index) => ({ id: `${nodes[index].id}-${node.id}`, from: nodes[index].id, to: node.id, branch: nodes[index].kind === 'condition' ? 'false' : null })),
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

const stopsOn = (id: string, reply: string): WorkflowNode => ({ id, kind: 'condition', source: '{{prev}}', test: 'regex', value: `(^|\\n)${reply}` })

/**
 * A workflow that watches Jira or Notion and takes each tagged item to a pull request with nobody in the loop: it plans on
 * the item, builds, tests for real, and opens the pull request; the hub then keeps it green until it is merged. Its watch
 * starts off unless it is ready to run as made
 */
export const ticketWorkflow = (source: Watch['source'], agent: string, watching: boolean): Workflow =>
  chain(NAME[source], [
    { id: 'input', kind: 'input', watches: [{ id: crypto.randomUUID(), source, query: WATCH_QUERY[source], ...(source === 'notion' && { dataSource: '' }), enabled: watching }] },
    agentStep('plan', agent, planPrompt(source)),
    stopsOn('asked', STOP.asked),
    agentStep('implement', agent, implementPrompt(source)),
    stopsOn('built', STOP.blocked),
    agentStep('qa', agent, qaPrompt(source)),
    stopsOn('verified', STOP.blocked),
    agentStep('pr', agent, prPrompt(source)),
    { id: 'output', kind: 'output', template: '{{prev}}' }
  ])

/** What the hub runs on a ticket's pull request when CI fails or a review comment comes in; its input names the fix */
export const fixWorkflow = (agent: string): Workflow =>
  chain('Fix pull request', [{ id: 'input', kind: 'input' }, agentStep('fix', agent, FIX_PROMPT), { id: 'output', kind: 'output', template: '{{prev}}' }])
