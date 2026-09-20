import { lazy, Suspense, useEffect, useState } from 'react'
import { type DocumentTab, type HostApi, type RendererPlugin, useHost } from '@treeix/sdk'
import { Icon } from '@treeix/app/Icon'
import type { Plan } from '../shared/types'
import './service'
import { listPlans, subscribePlans } from './api'

const PlanView = lazy(() => import('./PlanView').then((module) => ({ default: module.PlanView })))

function PlanTab({ plan }: { plan: Plan }): React.JSX.Element {
  const host = useHost()
  return (
    <Suspense fallback={null}>
      <PlanView
        key={plan.name}
        plan={plan}
        repos={host.repos}
        comments={host.comments.filter((comment) => comment.worktreePath === plan.path)}
        sendFrom={host.selectedWorktree ?? window.api.home}
        onDone={host.onSent}
        onDeleteComment={host.deleteComment}
        onClearComments={() => host.clearComments(plan.path)}
        onAddComment={(range, code, text, attachments) =>
          host.addComment({ id: crypto.randomUUID(), worktreePath: plan.path, filePath: plan.name, range, code, text, attachments, kind: 'file' })
        }
      />
    </Suspense>
  )
}

const openPlan = (host: HostApi, plan: Plan): void => {
  const tab: DocumentTab = {
    key: `plan:${plan.name}`,
    title: plan.title,
    icon: <Icon name="file" className="size-3.5 text-muted-foreground" />,
    parent: 'worktrees',
    panels: ['terminal'],
    content: <PlanTab plan={plan} />
  }
  host.openTab(tab)
}

/** The plan the session printed the path of, else the newest Claude plan written since it started */
function PlanButton({ startedAt, name }: { startedAt: number; name?: string | null }): React.JSX.Element | null {
  const host = useHost()
  const [plan, setPlan] = useState<Plan | null>(null)
  useEffect(
    () => subscribePlans((plans) => setPlan(plans.find((candidate) => (name ? candidate.name === name : candidate.modifiedAt >= startedAt)) ?? null)),
    [startedAt, name]
  )
  if (!plan) return null
  return (
    <button
      title={`Open plan: ${plan.title}`}
      onClick={() => openPlan(host, plan)}
      className="flex h-5 items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <Icon name="file" className="size-3" />
      Plan
    </button>
  )
}

// ponytail: the palette lists plans from the previous open, refreshed each time; fine while plans change slowly
let knownPlans: Plan[] = []
const refreshPlans = (): void => void listPlans().then((plans) => (knownPlans = plans), () => undefined)

const plugin: RendererPlugin = {
  Root: () => {
    useEffect(refreshPlans, [])
    return null
  },
  commands: (host) => {
    refreshPlans()
    return knownPlans.map((plan) => ({ id: `plan:${plan.name}`, group: 'Plans', label: plan.title, detail: plan.name, icon: 'file', run: () => openPlan(host, plan) }))
  },
  services: { plans: { PlanButton } }
}

export default plugin
