import '@xyflow/react/dist/style.css'
import { useEffect, useMemo, useState } from 'react'
import { applyNodeChanges, Background, type Edge, Handle, type Node, type NodeProps, Position, ReactFlow } from '@xyflow/react'
import { createBridge, PageLayout, PANE_HEADER, useHost } from '@treeix/sdk'
import { FLOW_THEME, FlowControls, prettify, START_ASPECT } from '@treeix/app/flow'
import { FileIcon, Icon } from '@treeix/app/Icon'
import { Segmented, Switch } from '@treeix/app/settingsUi'
import { errorMessage, IconButton, usePersisted } from '@treeix/app/ui'
import { useWorktreeFolder, WorktreeSelect } from '@treeix/app/WorktreeSelect'
import { folderGraph, type Graph, type GraphNode, packageGraph } from '../shared/graph'
import type { DependencyScan } from '../shared/types'

const bridge = createBridge('dependencies')

const WIDTH = 220
const HEIGHT = 52
const GAP = 16
const MAX_DEPTH = 6
const LAYOUT = { column: WIDTH + 100, height: () => HEIGHT + GAP }

type View = 'packages' | 'folders'
type BoxNode = Node<{ item: GraphNode }, 'box'>

function Box({ data: { item }, selected }: NodeProps<BoxNode>): React.JSX.Element {
  return (
    <div
      title={item.label}
      style={{ width: WIDTH, height: HEIGHT }}
      className={`flex flex-col justify-center rounded-lg border px-3 text-xs ${item.external ? 'border-dashed bg-muted/40 text-muted-foreground' : 'bg-popover'} ${selected ? 'border-primary' : 'border-border'}`}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <span className="truncate font-medium">{item.label}</span>
      <span className="truncate text-[11px] text-muted-foreground">{item.detail}</span>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  )
}

const NODE_TYPES = { box: Box }

function toFlow(graph: Graph): { nodes: BoxNode[]; edges: Edge[] } {
  const edges: Edge[] = graph.edges.map((edge) => ({
    id: `${edge.source}>${edge.target}:${edge.kind}`,
    source: edge.source,
    target: edge.target,
    data: { count: edge.count },
    // Faint until a node is picked, so a hundred links read as a shape instead of a wall
    style: { strokeOpacity: 0.25 }
  }))
  const nodes: BoxNode[] = graph.nodes.map((item, index) => ({ id: item.id, type: 'box', position: { x: 0, y: index }, data: { item } }))
  return { nodes: prettify(nodes, edges, { ...LAYOUT, aspect: START_ASPECT, layout: 'hierarchy' }), edges }
}

export function DependenciesPage(): React.JSX.Element {
  const host = useHost()
  const [worktree, setWorktree] = useWorktreeFolder()
  const [scan, setScan] = useState<DependencyScan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [view, setView] = usePersisted<View>('dependencies.view', 'folders')
  const [external, setExternal] = usePersisted<boolean>('dependencies.external', false)
  const [depth, setDepth] = usePersisted<number>('dependencies.depth', 3)

  const rescan = (): void => {
    if (!worktree) return
    setLoading(true)
    bridge
      .invoke<DependencyScan>('scan', worktree)
      .then((next) => (setScan(next), setError(null)))
      .catch((reason: unknown) => setError(errorMessage(reason)))
      .finally(() => setLoading(false))
  }
  useEffect(rescan, [worktree])

  // Positions are recomputed when the graph changes; dragging moves nodes until then
  const flow = useMemo(() => (scan ? toFlow(view === 'packages' ? packageGraph(scan.packages, external) : folderGraph(scan, depth)) : null), [scan, view, external, depth])
  const [nodes, setNodes] = useState<BoxNode[]>([])
  useEffect(() => setNodes(flow?.nodes ?? []), [flow])
  const selected = new Set(nodes.filter((node) => node.selected).map((node) => node.id))
  const edges = (flow?.edges ?? []).map((edge) =>
    selected.has(edge.source) || selected.has(edge.target)
      ? { ...edge, animated: true, label: view === 'folders' ? String(edge.data?.count) : undefined, style: { stroke: 'var(--color-primary)' } }
      : edge
  )

  const openManifest = (manifest: string): void => {
    if (!worktree) return
    host.openTab({
      key: `dependencies:${worktree}:${manifest}`,
      title: manifest,
      icon: <FileIcon path={manifest} />,
      parent: 'dependencies',
      content: host.renderFileView(worktree, manifest, null)
    })
  }

  const empty = !worktree
    ? 'Pick a worktree to see its dependencies'
    : (error ?? (flow && flow.nodes.length === 0 ? (view === 'packages' ? 'No package.json in this worktree' : 'No source files in this worktree') : null))

  const main = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={`${PANE_HEADER} @container gap-2 px-3 text-xs text-muted-foreground`}>
        <WorktreeSelect value={worktree} onChange={setWorktree} />
        <Segmented
          value={view}
          options={[
            ['folders', 'Folders'],
            ['packages', 'Packages']
          ]}
          onChange={setView}
        />
        {view === 'packages' ? (
          <span className="flex items-center gap-2">
            <Switch checked={external} onChange={() => setExternal(!external)} label="Show external packages" />
            External
          </span>
        ) : (
          <span title="Depth" className="flex shrink-0 items-center gap-1">
            <span className="hidden @xl:inline">Depth</span>
            <IconButton label="Shallower" onClick={() => setDepth(Math.max(1, depth - 1))}>
              <Icon name="narrow" className="size-3.5" />
            </IconButton>
            <span className="w-3 text-center text-foreground">{depth}</span>
            <IconButton label="Deeper" onClick={() => setDepth(Math.min(MAX_DEPTH, depth + 1))}>
              <Icon name="widen" className="size-3.5" />
            </IconButton>
          </span>
        )}
        <span className="flex-1" />
        <span className="hidden min-w-0 truncate @lg:inline">{flow ? `${flow.nodes.length} nodes, ${flow.edges.length} links` : loading ? 'Reading imports' : ''}</span>
        <IconButton label="Rescan" onClick={rescan}>
          <Icon name={loading ? 'loader' : 'refresh'} className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
        </IconButton>
      </div>
      {empty ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">{empty}</div>
      ) : (
        <ReactFlow
          key={`${view}:${depth}:${external}`}
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={(changes) => setNodes((current) => applyNodeChanges(changes, current))}
          onNodeDoubleClick={(_, node: BoxNode) => node.data.item.manifest && openManifest(node.data.item.manifest)}
          nodesConnectable={false}
          fitView
          // Labels stay readable in a narrow panel; the rest is a pan away
          fitViewOptions={{ maxZoom: 1, minZoom: 0.85 }}
          minZoom={0.1}
          proOptions={{ hideAttribution: true }}
          style={FLOW_THEME}
        >
          <Background gap={20} />
          <FlowControls onLayout={(view) => setNodes(prettify(nodes, edges, { ...LAYOUT, ...view }))} />
        </ReactFlow>
      )}
    </div>
  )
  return <PageLayout main={main} />
}
