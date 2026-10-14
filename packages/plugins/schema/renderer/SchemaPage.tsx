import '@xyflow/react/dist/style.css'
import { useEffect, useMemo, useState } from 'react'
import { applyNodeChanges, Background, type Edge, Handle, type Node, type NodeProps, Position, ReactFlow } from '@xyflow/react'
import { createBridge, PageLayout, PANE_HEADER, useHost } from '@treeix/sdk'
import { FLOW_THEME, FlowControls, layered, prettify } from '@treeix/app/flow'
import { FileIcon, Icon } from '@treeix/app/Icon'
import { baseName } from '@treeix/app/Sidebar'
import { errorMessage, IconButton } from '@treeix/app/ui'
import type { Schema, Table } from '../shared/types'

const bridge = createBridge('schema')

const WIDTH = 260
const HEADER = 34
const ROW = 24
const GAP = 40

type TableNode = Node<{ table: Table; enums: Schema['enums']; linked: Set<string> }, 'table'>

const LAYOUT = { column: WIDTH + 120, height: (node: TableNode) => HEADER + node.data.table.columns.length * ROW + GAP }

const handleId = (column: string, side: 'in' | 'out'): string => `${column}:${side}`

function TableCard({ data: { table, enums, linked }, selected }: NodeProps<TableNode>): React.JSX.Element {
  return (
    <div style={{ width: WIDTH }} className={`overflow-hidden rounded-lg border bg-popover text-xs ${selected ? 'border-primary' : 'border-border'}`}>
      <div style={{ height: HEADER }} className="flex items-center gap-1.5 border-b border-border bg-muted/50 px-3 font-medium">
        <Icon name="database" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{table.name}</span>
      </div>
      {table.columns.map((column) => (
        <div
          key={column.key}
          style={{ height: ROW }}
          title={enums[column.type] ? `${column.type}: ${enums[column.type].join(' | ')}` : undefined}
          className="relative flex items-center gap-2 px-3"
        >
          {linked.has(column.key) && <Handle id={handleId(column.key, 'in')} type="target" position={Position.Left} isConnectable={false} />}
          <span className="w-6 shrink-0 font-mono text-[10px] text-amber-400">{column.primaryKey ? 'PK' : linked.has(column.key) ? 'FK' : ''}</span>
          <span className={`min-w-0 flex-1 truncate font-mono ${column.notNull ? '' : 'text-muted-foreground'}`}>
            {column.name}
            {column.notNull ? '' : '?'}
          </span>
          <span className="max-w-24 truncate font-mono text-muted-foreground">
            {column.type}
            {column.unique && !column.primaryKey ? ' uq' : ''}
            {column.hasDefault ? ' =' : ''}
          </span>
          {linked.has(column.key) && <Handle id={handleId(column.key, 'out')} type="source" position={Position.Right} isConnectable={false} />}
        </div>
      ))}
    </div>
  )
}

const NODE_TYPES = { table: TableCard }

/** Parent tables on the left: an edge runs from the referenced column to the column holding the foreign key */
function toFlow(schema: Schema): { nodes: TableNode[]; edges: Edge[] } {
  const edges: Edge[] = schema.relations.flatMap((relation) =>
    relation.columns.map((column, index) => {
      const toColumn = relation.toColumns[index] ?? relation.toColumns[0]
      return {
        id: `${relation.from}.${column}>${relation.to}.${toColumn}`,
        source: relation.to,
        sourceHandle: handleId(toColumn, 'out'),
        target: relation.from,
        targetHandle: handleId(column, 'in')
      }
    })
  )
  const linked = new Map<string, Set<string>>()
  const link = (table: string, column: string): void => void linked.set(table, (linked.get(table) ?? new Set()).add(column))
  for (const relation of schema.relations) {
    relation.columns.forEach((column) => link(relation.from, column))
    relation.toColumns.forEach((column) => link(relation.to, column))
  }
  const nodes: TableNode[] = schema.tables.map((table, index) => ({
    id: table.id,
    type: 'table',
    position: { x: 0, y: index },
    data: { table, enums: schema.enums, linked: linked.get(table.id) ?? new Set() }
  }))
  return { nodes: layered(nodes, edges, LAYOUT), edges }
}

export function SchemaPage(): React.JSX.Element {
  const host = useHost()
  const worktree = host.selectedWorktree
  const [schema, setSchema] = useState<Schema | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const scan = (): void => {
    if (!worktree) return
    setLoading(true)
    bridge
      .invoke<Schema>('scan', worktree)
      .then((next) => (setSchema(next), setError(null)))
      .catch((reason: unknown) => setError(errorMessage(reason)))
      .finally(() => setLoading(false))
  }
  useEffect(scan, [worktree])

  // Positions are recomputed per scan; dragging moves nodes until the next one
  const flow = useMemo(() => (schema ? toFlow(schema) : null), [schema])
  const [nodes, setNodes] = useState<TableNode[]>([])
  useEffect(() => setNodes(flow?.nodes ?? []), [flow])
  const selected = new Set(nodes.filter((node) => node.selected).map((node) => node.id))
  const edges = (flow?.edges ?? []).map((edge) =>
    selected.has(edge.source) || selected.has(edge.target) ? { ...edge, animated: true, style: { stroke: 'var(--color-primary)' } } : edge
  )

  const openSource = (table: Table): void => {
    if (!worktree) return
    host.openTab({
      key: `schema:${worktree}:${table.file}`,
      title: baseName(table.file),
      icon: <FileIcon path={table.file} />,
      parent: 'schema',
      content: host.renderFileView(worktree, table.file, table.line)
    })
  }

  const empty = !worktree ? 'Select a worktree to see its schema' : error ? error : schema && schema.tables.length === 0 ? 'No Drizzle tables found in this worktree' : null

  const main = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={`${PANE_HEADER} gap-2 px-3 text-xs text-muted-foreground`}>
        <span className="truncate">
          {schema ? `${schema.tables.length} tables, ${schema.relations.length} relations` : loading ? 'Reading schema files' : ''}
          {schema?.errors.length ? ` · ${schema.errors.length} files unreadable` : ''}
        </span>
        <span className="flex-1" />
        <span className="hidden sm:inline">Double-click a table for its source</span>
        <IconButton label="Rescan" onClick={scan}>
          <Icon name={loading ? 'loader' : 'refresh'} className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
        </IconButton>
      </div>
      {empty ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">{empty}</div>
      ) : (
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={(changes) => setNodes((current) => applyNodeChanges(changes, current))}
          onNodeDoubleClick={(_, node: TableNode) => openSource(node.data.table)}
          nodesConnectable={false}
          fitView
          fitViewOptions={{ maxZoom: 1 }}
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
