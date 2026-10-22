import type { Api, CreateSession } from '../../ipc/api'
import { runIn } from '../../panels/common'
import { paneGrid } from '../../panes/terminal/xterm'
import type { ShellView } from '../../shell/Shell'
import { newTabId } from '../../shell/state'
import { DRAFT_PR, type AgentName } from './race'

export interface LaunchPane {
  cwd: string
  agent: AgentName | null
}

export interface LaunchOptions {
  /** The agents' first prompt */
  prompt: string
  /** A shell split under each agent */
  shell: boolean
  /** Push and open a draft PR once the agent first finishes */
  draftPr: boolean
}

/** Runs `run` the first time the session turns done; gives up when it exits */
function whenDone(api: Api, session: string, run: () => unknown) {
  const stop = api.onEvent((e) => {
    if ((e.type === 'exit' || e.type === 'removed') && e.session === session) stop()
    else if (e.type === 'status' && e.session === session && e.status === 'done') {
      stop()
      void run()
    }
  })
}

/** Opens new worktrees' agents in one tab, side by side, each with an optional shell under it */
export async function launch(view: ShellView, panes: LaunchPane[], { prompt, shell, draftPr }: LaunchOptions) {
  const box = document.querySelector('main.center')?.getBoundingClientRect()
  const grid = paneGrid((box?.width ?? innerWidth) / panes.length, (box?.height ?? innerHeight) / (shell ? 2 : 1))
  const create = (opts: Pick<CreateSession, 'kind' | 'cwd' | 'command'>) => view.api.create({ ...opts, ...grid })
  const agents: string[] = []
  for (const [i, { cwd, agent }] of panes.entries()) {
    const info = await create({ kind: agent ?? 'shell', cwd, command: agent ? (prompt ? [agent, prompt] : [agent]) : undefined })
    view.dispatch(i === 0 ? { type: 'open', session: info.id, tabId: newTabId() } : { type: 'split', session: info.id, dir: 'row', place: panes[0].cwd })
    agents.push(info.id)
  }
  const shells: string[] = []
  if (shell)
    for (const [i, id] of agents.entries()) {
      view.dispatch({ type: 'focus', session: id })
      const info = await create({ kind: 'shell', cwd: panes[i].cwd })
      view.dispatch({ type: 'split', session: info.id, dir: 'col', place: panes[0].cwd })
      shells.push(info.id)
    }
  view.dispatch({ type: 'focus', session: agents[0] })
  if (draftPr && prompt)
    agents.forEach((id, i) => panes[i].agent && whenDone(view.api, id, () => (shells[i] ? view.api.write(shells[i], `${DRAFT_PR}\r`) : runIn(view, panes[i].cwd, DRAFT_PR))))
}
