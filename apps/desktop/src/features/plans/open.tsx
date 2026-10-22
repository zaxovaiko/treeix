import type { PlanFile } from '../../ipc/api'
import { Icon } from '../../lib/icons'
import type { Command } from '../../lib/paletteSearch'
import type { ShellView } from '../../shell/Shell'
import { leaves } from '../../shell/state'

// Phase 7 plan pane leaves (owner G7). A plan is a pane leaf `plan:<file name in ~/.claude/plans>`

const PREFIX = 'plan:'

export const planLeaf = (name: string): string => `${PREFIX}${name}`
export const isPlanLeaf = (leaf: string): boolean => leaf.startsWith(PREFIX)
export const leafPlan = (leaf: string): string => leaf.slice(PREFIX.length)

/** Opens the plan split right of the focused pane, or focuses it when it is open */
export function openPlan(view: Pick<ShellView, 'dispatch' | 'ui' | 'activeTab' | 'placeOfTab'>, name: string): void {
  const leaf = planLeaf(name)
  if (view.ui.tabs.some((tab) => leaves(tab.root).includes(leaf))) return view.dispatch({ type: 'focus', session: leaf })
  const place = view.activeTab ? view.placeOfTab(view.activeTab).key : undefined
  view.dispatch({ type: 'split', session: leaf, dir: 'row', place })
}

export const closePlan = (view: Pick<ShellView, 'dispatch'>, leaf: string): void => view.dispatch({ type: 'remove', session: leaf })

// The last plan list seen, for titles and palette commands, which are built synchronously
let knownPlans: PlanFile[] = []
export const rememberPlans = (list: PlanFile[]): void => void (knownPlans = list)

/** The pane header in a split: the plan's title, its file name until the list arrives */
export function PlanHead({ leaf }: { leaf: string }) {
  'use no memo' // reads knownPlans, which changes outside React
  const name = leafPlan(leaf)
  return (
    <>
      <Icon name="file" />
      <span className="trunc grow">{knownPlans.find((plan) => plan.name === name)?.title ?? name}</span>
    </>
  )
}

/** "Open plan: <title>" per plan known so far; each call refreshes the list for the next palette */
export function planCommands(view: ShellView): Command[] {
  void view.api.plansList().then(rememberPlans, () => undefined)
  return knownPlans.map((plan) => ({ id: `plan-open-${plan.name}`, group: 'Actions', label: `Open plan: ${plan.title}`, icon: 'file', run: () => openPlan(view, plan.name) }))
}
