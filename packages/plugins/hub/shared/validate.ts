import { references } from './template'
import type { Workflow, WorkflowNode } from './workflow'

/** Something that keeps a workflow from running; `node` is null when it's about the whole workflow */
export type Problem = { node: string | null; message: string }

const templatesOf = (node: WorkflowNode): string[] => {
  switch (node.kind) {
    case 'input':
      return []
    case 'agent':
      return [node.prompt]
    case 'condition':
      return [node.source]
    case 'approval':
      return [node.message]
    case 'merge':
    case 'output':
      return [node.template]
  }
}

function reach(workflow: Workflow, id: string, back: boolean): Set<string> {
  const seen = new Set<string>()
  const near = (node: string): string[] => workflow.edges.filter((edge) => (back ? edge.to : edge.from) === node).map((edge) => (back ? edge.from : edge.to))
  const stack = near(id)
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    if (seen.has(next)) continue
    seen.add(next)
    stack.push(...near(next))
  }
  return seen
}

/** Every step that runs before `id`, found by walking its edges back */
export const ancestors = (workflow: Workflow, id: string): Set<string> => reach(workflow, id, true)

/** Every step that runs after `id` */
export const descendants = (workflow: Workflow, id: string): Set<string> => reach(workflow, id, false)

/** What has to change before the workflow can run, given the ids of the agents that exist */
export function validate(workflow: Workflow, agents: string[]): Problem[] {
  const problems: Problem[] = []
  const inputs = workflow.nodes.filter((node) => node.kind === 'input').length
  if (inputs !== 1) problems.push({ node: null, message: inputs ? 'Has more than one input' : 'Has no input' })
  if (!workflow.nodes.some((node) => node.kind === 'output')) problems.push({ node: null, message: 'Add an output step' })

  for (const node of workflow.nodes) {
    const add = (message: string): void => void problems.push({ node: node.id, message })
    const before = ancestors(workflow, node.id)
    if (before.has(node.id)) add('Loops back to itself')
    if (node.kind !== 'input' && before.size === 0) add('Connect a step to it')
    if (node.kind === 'agent' && !agents.includes(node.agent)) add('Pick an agent')
    if (node.kind === 'agent' && !node.prompt.trim()) add('Write a prompt')
    if (node.kind === 'condition' && !workflow.edges.some((edge) => edge.from === node.id)) add('Connect its yes or no side')
    if (node.kind === 'condition' && node.test === 'regex') {
      try {
        new RegExp(node.value)
      } catch {
        add('The pattern is not a valid regular expression')
      }
    }
    for (const id of templatesOf(node).flatMap(references)) {
      if (!before.has(id)) add(`{{nodes.${id}.output}} is not a step before this one`)
    }
  }
  return problems
}
