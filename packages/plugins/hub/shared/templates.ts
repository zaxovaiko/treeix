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

/** A workflow that watches Jira or Notion and has an agent take each new item to a pull request; its watch starts off, so nothing runs before the agent and folder are checked */
export const shipWorkflow = (source: Watch['source'], agent: string): Workflow => ({
  id: crypto.randomUUID(),
  name: NAME[source],
  nodes: [
    { id: 'input', kind: 'input', watches: [{ id: crypto.randomUUID(), source, query: WATCH_QUERY[source], ...(source === 'notion' && { dataSource: '' }), enabled: false }] },
    { id: 'ship', kind: 'agent', agent, prompt: shipPrompt(source), folder: null, retries: 0, onError: 'stop', timeoutMin: MAX_TIMEOUT_MIN },
    { id: 'output', kind: 'output', template: '{{prev}}' }
  ],
  edges: [
    { id: 'input-ship', from: 'input', to: 'ship', branch: null },
    { id: 'ship-output', from: 'ship', to: 'output', branch: null }
  ],
  layout: { input: { x: 0, y: 0 }, ship: { x: 260, y: 0 }, output: { x: 520, y: 0 } },
  updatedAt: Date.now()
})
