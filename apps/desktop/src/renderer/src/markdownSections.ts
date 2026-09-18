/** Minimal shape of the markdown nodes this transform touches */
type Node = { type: string; depth?: number; children?: Node[] }

export type SectionNode = Node & { type: 'section'; data: { hName: 'section'; hProperties: { dataLevel: number } } }

/**
 * Wraps each heading and everything under it, up to the next heading of the same or higher rank,
 * in a section the renderer can collapse.
 */
export function sectionize(nodes: Node[]): Node[] {
  const result: Node[] = []
  let index = 0
  while (index < nodes.length) {
    const node = nodes[index]
    const depth = node.type === 'heading' ? (node.depth ?? 1) : null
    if (depth === null) {
      result.push(node)
      index += 1
      continue
    }
    let end = index + 1
    while (end < nodes.length && !(nodes[end].type === 'heading' && (nodes[end].depth ?? 1) <= depth)) end += 1
    const section: SectionNode = {
      type: 'section',
      data: { hName: 'section', hProperties: { dataLevel: depth } },
      children: [node, ...sectionize(nodes.slice(index + 1, end))]
    }
    result.push(section)
    index = end
  }
  return result
}

/** remark plugin: `() => (tree) => ...` */
export const remarkSections = () => (tree: Node): void => {
  tree.children = sectionize(tree.children ?? [])
}
