export type AgentName = 'claude' | 'codex'

export interface Target {
  branch: string
  agent: AgentName | null
}

/** One worktree per agent when several get the same task (`feat/x-claude`, `feat/x-codex`), else the branch itself */
export const raceTargets = (branch: string, agents: AgentName[]): Target[] =>
  agents.length > 1 ? agents.map((agent) => ({ branch: `${branch}-${agent}`, agent })) : [{ branch, agent: agents[0] ?? null }]

/** Typed into the agent's shell once it finishes: pushes, then a draft PR (gh) or MR (glab) by the origin's host. `sh -c` so fish runs it too */
export const DRAFT_PR = `sh -c 'git push -u origin HEAD && if git remote get-url origin | grep -qi gitlab; then glab mr create --draft --fill --yes; else gh pr create --draft --fill; fi'`
