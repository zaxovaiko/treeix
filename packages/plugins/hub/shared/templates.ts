import { MAX_TIMEOUT_MIN } from './types'
import { type JudgeNode, MAX_SCORE, WATCH_QUERY, type Watch, type Workflow, type WorkflowNode } from './workflow'

/** The steps read the item's source from it, so one workflow can watch Jira and Notion both */
const ITEM = `Item: {{input.title}} ({{input.source}} {{input.key}})
Link: {{input.url}}
Tools: a Jira ticket through the Treeix jira_work_item, jira_comment, jira_transition and jira_edit_labels tools; a Notion task through the Treeix notion_page, notion_comment and notion_update_page tools, else the ntn CLI, else a Notion MCP.`

const ON_YOUR_OWN = 'on your own: nobody watches this run'
/** Output from search, CI and browsers stays in a subagent's context, so the step's own stays small through its turns */
const SUBAGENTS =
  'Keep your own context small: hand work that reads or prints a lot (searching the code, running CI and tests, a browser check) to subagents, each with one bounded task and a short verdict back. Haiku only to read logs or sum up long text; Sonnet at medium or high effort for work with a clear plan; Opus at medium or high effort for critical functionality. Subagents start none of their own.'
const CODE_ONLY = 'The branch holds only code and tests the work needs: no test output, proof, logs, scratch scripts or generated files'
const NO_ATTRIBUTION = 'No AI attribution anywhere: no Co-Authored-By, no "Generated with" line'
const UNMARK = "take off the mark that started this run: Jira's agent-ready label, Notion's Agent property"
const WORKTREE = `What the build step did:
{{nodes.build.output}}`

/** An agent replying with this, on its own line, stops the ticket for a person; the board shows it as Needs you */
export const STOP = { asked: 'Asked:', blocked: 'Blocked:' } as const

const PLAN_PROMPT = `You plan one ticket, ${ON_YOUR_OWN}. Change no code yet.

${ITEM}

1. Move it to its status that means in progress, if it has one.
2. Read it in full, with its comments, tech notes and linked docs, and the code it touches. Follow the repo's AGENTS.md or CLAUDE.md. ${SUBAGENTS}
3. If it is unclear what to build, or it needs a decision only a person can make: ask in one comment on it, then ${UNMARK}, and reply only "${STOP.asked} " and the questions.
4. Otherwise post one comment titled "Plan": a "- [ ]" checklist of what changes where, and what is left out. Under it, "Test cases": every acceptance criterion as a check a tester can run, then one for each real risk you find beyond the ticket: where the change can break (code that calls what it touches, boundaries, empty or bad data, permissions, concurrency, stored data, other screens), each with how it is checked: a test, an API call, a CLI check of a real system, or a screen in a browser or simulator. Short and in plain words.

Reply with the plan as posted.`

const BUILD_PROMPT = `You build one ticket, ${ON_YOUR_OWN}.

${ITEM}

The plan, posted on it:
{{nodes.plan.output}}

1. Read it again: comments added since the plan count too. Follow the repo's AGENTS.md or CLAUDE.md, its skills and its subagents. ${SUBAGENTS}
2. Work in a git worktree on a branch made for this ticket: this folder, if it is one; else add one off the freshly pulled target branch of the repo it belongs to. Leave the user's checkout alone.
3. Take the simplest approach that meets every test case. A bug: reproduce it first. A frontend task: build the UI first, every state it adds (empty, loading, error, both themes), then what drives it. Add tests for the plan's test cases where the repo has tests.
4. Run the repo's CI commands until they pass. Commit with the repo's commit style. ${CODE_ONLY}. ${NO_ATTRIBUTION}.
5. If you can't finish it: say why in one comment on it, and reply only "${STOP.blocked} " and the reason.

End your reply with two lines: "Worktree: <its absolute path>" and "Branch: <its name>".`

const TEST_PROMPT = `You test one ticket for real, ${ON_YOUR_OWN}. Change no app code: the build step fixes what fails. Tests that prove a case you checked may be added, committed like the build's.

${ITEM}

${WORKTREE}

1. Read it and list every test case in its Plan comment, and every acceptance criterion its comments add. ${SUBAGENTS}
2. Check each one in the worktree the way the plan says: the repo's tests, an API call, the real systems through their CLI tools (aws, sentry and the like), and a browser (web) or simulator (mobile) only for a screen the work changes. Check every detail, not just the happy path.
3. Remove the data you made to test, and stop what you started.
4. Save outside the repo, in $TMPDIR/treeix-proof/<branch>, only images anyone may see on a public pull request: screenshots of each changed screen (both themes if it has them), a short video of the flow, and screenshots of what changed in a service's console (AWS and the like). No logs, scripts or command output, there or in the worktree. Crop or blur secrets, tokens, account ids, emails and personal data.
5. If nothing can be run at all, say why in one comment on it, and reply only "${STOP.blocked} " and why.

Reply with each test case that failed or couldn't be checked, one per line, with what happened and why, or "All test cases passed". Then the proof files.`

const PR_PROMPT = `You open the pull request for one ticket, ${ON_YOUR_OWN}.

${ITEM}

${WORKTREE}

What testing found:
{{nodes.test.output}}

1. Follow the repo's AGENTS.md or CLAUDE.md for branches and pull requests.
2. Push the branch and open a pull request (or merge request) that links the item, says what changed, and lists the test cases testing couldn't check, if any. ${CODE_ONLY}: remove any before you push. Push the images testing saved in $TMPDIR/treeix-proof/<branch>, if any, to an orphan branch named proof/<this branch> and embed them from there. ${NO_ATTRIBUTION}.
3. Comment the link on it, move it to its status that means in review (In review, Code Review or the like) if it has one, and ${UNMARK}.

End your reply with "PR: " and the pull request URL on its own line.`

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

/** Failed or unchecked test cases and code review in one judge, which sends the build back until nothing is left to fix */
const reviewStep = (agent: string): JudgeNode => ({
  id: 'review',
  kind: 'judge',
  agent,
  source: `${ITEM}\n\n${WORKTREE}\n\nWhat testing found:\n{{nodes.test.output}}`,
  rubric:
    "Each test case testing found failed or couldn't check is an issue, with what happened. Then review the diff in the worktree against its target branch from every side: bugs and edge cases, security, tests that prove the test cases, the repo's conventions in its AGENTS.md or CLAUDE.md, code a simpler version would replace, and any file the work doesn't need (test output, proof, logs, scratch scripts, generated files). The repo's review subagents, if it defines any, review their part and you fold in what they find. Each issue names the file and line, and the fix. Only issues worth a change: nothing a formatter or linter owns, no matter of taste.",
  minScore: MAX_SCORE,
  retryStep: 'build',
  rounds: 3,
  onError: 'stop'
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
 * the item with its test cases, builds, tests for real, and reviews. A failed test or any review issue sends the build back,
 * and the steps after run again. Then it opens the pull request and the hub keeps it green until it is merged. Its steps
 * read the source from the item, so another watch can be added either way. Its watch starts off unless it is ready to run as made
 */
export const ticketWorkflow = (source: Watch['source'], agent: string, watching: boolean): Workflow =>
  chain(NAME[source], [
    { id: 'input', kind: 'input', watches: [{ id: crypto.randomUUID(), source, query: WATCH_QUERY[source], ...(source === 'notion' && { dataSource: '' }), enabled: watching }] },
    agentStep('plan', agent, PLAN_PROMPT),
    stopsOn('asked', STOP.asked),
    agentStep('build', agent, BUILD_PROMPT),
    stopsOn('built', STOP.blocked),
    agentStep('test', agent, TEST_PROMPT),
    stopsOn('tested', STOP.blocked),
    reviewStep(agent),
    agentStep('pr', agent, PR_PROMPT),
    { id: 'output', kind: 'output', template: '{{prev}}' }
  ])

const SHIP_PROMPT = `/ship {{input.key}}

You run ${ON_YOUR_OWN}. This folder is the ticket's own worktree: build in it, on its branch, and add no other worktree. Start every comment you leave on the pull request with "Agent:", so it never reads as a new one to answer. Treeix watches the pull request once it is ready for review, so stop there and end your reply with its link, or, when ship stops on a question or a blocker, with "${STOP.asked} " or "${STOP.blocked} " on its own line and the reason.`

/** For a repo whose own ship skill plans, builds, tests, reviews and opens the pull request: one step hands it the ticket */
export const shipSkillWorkflow = (agent: string, watching: boolean): Workflow =>
  chain('Ship Jira tickets with /ship', [
    { id: 'input', kind: 'input', watches: [{ id: crypto.randomUUID(), source: 'jira', query: WATCH_QUERY.jira, enabled: watching }] },
    agentStep('pr', agent, SHIP_PROMPT),
    stopsOn('asked', STOP.asked),
    stopsOn('blocked', STOP.blocked),
    { id: 'output', kind: 'output', template: '{{nodes.pr.output}}' }
  ])

const SHIP_FIX_PROMPT = `/ship {{input.key}}

You run ${ON_YOUR_OWN}. Start every comment you leave on the pull request with "Agent:", so it never reads as a new one to answer. Its pull request {{input.url}} on {{input.sourceBranch}} needs this:

{{input.details}}

Treeix keeps watching the pull request, so stop once it is ready for review again. End your reply with what you changed, in one line.`

/**
 * What the hub runs on a ticket's pull request when CI fails or a review comment comes in; its input names the fix. A ticket
 * its repo's /ship skill shipped goes back to /ship, which fixes, tests and reviews the change like the rest of the ticket
 */
export const fixWorkflow = (agent: string, viaShip = false): Workflow =>
  chain('Fix pull request', [
    { id: 'input', kind: 'input' },
    agentStep('fix', agent, viaShip ? SHIP_FIX_PROMPT : FIX_PROMPT),
    { id: 'output', kind: 'output', template: '{{prev}}' }
  ])

/** Whether a workflow hands its ticket to the repo's /ship skill */
export const shipsWithSkill = (workflow: Workflow): boolean => workflow.nodes.some((node) => node.kind === 'agent' && node.prompt.trimStart().startsWith('/ship '))
