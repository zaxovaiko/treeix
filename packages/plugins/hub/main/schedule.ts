import type { Edge, NodeRun, NodeStatus, Workflow, WorkflowNode } from '../shared/workflow'

const SETTLED: NodeStatus[] = ['done', 'failed', 'skipped', 'cancelled']

/** An edge carries its source's output once the source finished, on the edge's side of a condition; a failed source that let the run continue passes nothing */
export const isLive = (edge: Edge, nodes: Record<string, NodeRun>): boolean => {
  const source = nodes[edge.from]
  return (source.status === 'done' || source.status === 'failed') && (edge.branch === null || source.branch === edge.branch)
}

/** Pending nodes whose inputs have all settled: ready when one of them is live, skipped when none is */
export function nextSteps(workflow: Workflow, nodes: Record<string, NodeRun>): { ready: string[]; skip: string[] } {
  const ready: string[] = []
  const skip: string[] = []
  for (const node of workflow.nodes) {
    if (nodes[node.id].status !== 'pending') continue
    const inputs = workflow.edges.filter((edge) => edge.to === node.id)
    if (!inputs.every((edge) => SETTLED.includes(nodes[edge.from].status))) continue
    if (inputs.length === 0 || inputs.some((edge) => isLive(edge, nodes))) ready.push(node.id)
    else skip.push(node.id)
  }
  return { ready, skip }
}

/** Which way a condition goes; a bad pattern throws */
export function holds(node: Extract<WorkflowNode, { kind: 'condition' }>, source: string): boolean {
  switch (node.test) {
    case 'contains':
      return source.includes(node.value)
    case 'equals':
      return source.trim() === node.value.trim()
    case 'regex':
      return new RegExp(node.value).test(source)
    case 'empty':
      return source.trim() === ''
  }
}
