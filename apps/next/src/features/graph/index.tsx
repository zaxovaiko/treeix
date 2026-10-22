import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ModuleGraph } from '../../ipc/api'
import { Icon } from '../../lib/icons'
import type { ShellView } from '../../shell/Shell'
import { cycleGroups, filterGraph, findPath, layout, levelGraph, unresolvedId, type Box, type Edge, type Level } from './graph'
import '../../styles/graph.css'

const LEVELS: [Level, string][] = [
  ['packages', 'Packages'],
  ['folders', 'Folders'],
  ['files', 'Files'],
]
const EDGE_CLASS = { static: '', require: '', type: 'type', dynamic: 'dyn' } as const

/** An edge's curve: forward edges bow right, edges back to an earlier column loop under both nodes */
function curve(a: Box, b: Box): string {
  if (b.x > a.x) {
    const [x1, y1, x2, y2] = [a.x + a.w, a.y + 15, b.x - 4, b.y + 15]
    const dx = Math.max(30, (x2 - x1) / 2)
    return `M${x1} ${y1} C${x1 + dx} ${y1},${x2 - dx} ${y2},${x2} ${y2}`
  }
  const [ax, bx, low] = [a.x + a.w / 2, b.x + b.w / 2, Math.max(a.y, b.y) + 80]
  return `M${ax} ${a.y + 30} C${ax} ${low},${bx} ${low},${bx} ${b.y + 34}`
}

/** Packages / Folders / Files, why A imports B, cycles, unresolved imports, re-scan; `onClose` goes back to the terminal */
export function GraphPage({ view, onClose }: { view: ShellView; onClose: () => void }) {
  const place = view.activeTab ? view.placeOfTab(view.activeTab) : null
  const root = place?.path ?? null
  const [scan, setScan] = useState<{ graph: ModuleGraph; ms: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [level, setLevel] = useState<Level>('packages')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [path, setPath] = useState<string[] | null>(null)
  const [ends, setEnds] = useState<[string, string]>(['', ''])

  const rescan = useCallback(() => {
    if (!root) return
    const started = performance.now()
    setBusy(true)
    view.api.graphScan(root).then(
      (graph) => {
        setScan({ graph, ms: Math.round(performance.now() - started) })
        setError(null)
        setBusy(false)
      },
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason))
        setBusy(false)
      },
    )
  }, [view.api, root])
  useEffect(rescan, [rescan])

  const shown = useMemo(() => (scan ? filterGraph(levelGraph(scan.graph, level), query) : null), [scan, level, query])
  const drawn = useMemo(() => (shown ? layout(shown) : null), [shown])
  const cycles = useMemo(() => (shown ? cycleGroups(shown.nodes.map((node) => node.id), shown.edges) : []), [shown])

  const top = (
    <div className="gtop">
      <button className="btn sm" onClick={onClose}>
        <Icon name="left" />
        Terminal
      </button>
      <b>Module graph</b>
      <span className="dim trunc">{place?.name}</span>
      {scan && (
        <>
          <div className="seg">
            {LEVELS.map(([id, label]) => (
              <button
                key={id}
                className={level === id ? 'on' : ''}
                onClick={() => {
                  setLevel(id)
                  setSelected(null)
                  setPath(null)
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <input className="gfilter" placeholder="Filter" value={query} onChange={(e) => setQuery(e.target.value)} />
        </>
      )}
      <span className="grow" />
      {scan && (
        <span className="dim gstat">
          {scan.graph.files.length} files in {scan.ms} ms
        </span>
      )}
      <span className="tag green" title="Resolved with oxc-resolver: tsconfig paths, package exports and conditions, workspaces, import(), require(), type-only imports">
        oxc-resolver
      </span>
      <button className="btn sm ghost" disabled={busy || !root} onClick={rescan} title="Re-scan">
        {busy ? 'Scanning...' : 'Re-scan'}
      </button>
    </div>
  )

  if (!scan || !shown || !drawn)
    return (
      <div className="graph">
        {top}
        <div className="empty gempty">
          <Icon name="network" />
          <div>{error ?? (root ? 'Scanning imports...' : 'Open a repo to see its modules.')}</div>
        </div>
      </div>
    )
  if (!scan.graph.files.length)
    return (
      <div className="graph">
        {top}
        <div className="empty gempty">
          <Icon name="network" />
          <div>No JS or TS modules in {place?.name}.</div>
          <div className="dim">The graph reads package.json, tsconfig and imports.</div>
        </div>
      </div>
    )

  const { nodes, edges, unresolved } = shown
  const label = (id: string) => nodes.find((node) => node.id === id)?.label ?? id
  const inCycle = new Map(cycles.flatMap((group, i) => group.map((id) => [id, i])))
  const cyclic = (edge: Edge) => edge.kind !== 'type' && inCycle.has(edge.from) && inCycle.get(edge.from) === inCycle.get(edge.to)
  const onPath = new Set(path ?? [])
  const pathEdges = new Set((path ?? []).slice(1).map((to, i) => `${path?.[i]}>${to}`))
  const near = selected ? new Set([selected, ...edges.filter((e) => e.from === selected || e.to === selected).flatMap((e) => [e.from, e.to])]) : null
  const lit = onPath.size > 0 || selected !== null
  const [from, to] = [nodes.some((n) => n.id === ends[0]) ? ends[0] : (nodes[0]?.id ?? ''), nodes.some((n) => n.id === ends[1]) ? ends[1] : (nodes.at(-1)?.id ?? '')]
  const open = (file: string, line: number) => view.openFile(scan.graph.root, file, line)
  const pick = (id: string) => {
    setSelected(id === selected ? null : id)
    setPath(null)
  }

  return (
    <div className="graph">
      {top}
      <div className="gbody">
        <div className="gcanvas" onClick={() => (setSelected(null), setPath(null))}>
          <div style={{ position: 'relative', width: drawn.width, height: drawn.height }}>
            <svg className="edges" style={{ width: drawn.width, height: drawn.height }} viewBox={`0 0 ${drawn.width} ${drawn.height}`}>
              <defs>
                {(
                  [
                    ['ah', 'var(--muted-foreground)'],
                    ['ah-r', 'var(--red)'],
                    ['ah-p', 'var(--primary)'],
                  ] as const
                ).map(([id, color]) => (
                  <marker key={id} id={id} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                    <path d="M0 0 8 4 0 8z" style={{ fill: color, stroke: 'none' }} />
                  </marker>
                ))}
              </defs>
              {edges.map((edge) => {
                const a = drawn.pos.get(edge.from)
                const b = drawn.pos.get(edge.to)
                if (!a || !b) return null
                const cyc = cyclic(edge)
                const hot = pathEdges.has(`${edge.from}>${edge.to}`) || (cyc && onPath.has(edge.from) && onPath.has(edge.to)) || (selected !== null && (edge.from === selected || edge.to === selected))
                const cls = ['e', EDGE_CLASS[edge.kind], cyc && 'cyc', hot ? 'hot' : lit && 'dim'].filter(Boolean).join(' ')
                return <path key={`${edge.from}>${edge.to}`} className={cls} d={curve(a, b)} markerEnd={`url(#${hot ? 'ah-p' : cyc ? 'ah-r' : 'ah'})`} />
              })}
              {unresolved.map((item, i) => {
                const a = drawn.pos.get(item.from)
                const b = drawn.pos.get(unresolvedId(i))
                return a && b && <path key={i} className={lit && selected !== item.from ? 'e unres dim' : 'e unres'} d={curve(a, b)} markerEnd="url(#ah-r)" />
              })}
            </svg>
            {nodes.map((node) => {
              const box = drawn.pos.get(node.id)
              if (!box) return null
              const cls = ['gn', node.external && 'ext', inCycle.has(node.id) && 'cyc', selected === node.id && 'sel', onPath.has(node.id) && 'path', lit && !onPath.has(node.id) && !near?.has(node.id) && 'dim'].filter(Boolean).join(' ')
              return (
                <div
                  key={node.id}
                  className={cls}
                  style={{ left: box.x, top: box.y }}
                  title={node.external ? `${node.label}, outside the repo` : `${node.files} file${node.files === 1 ? '' : 's'}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    pick(node.id)
                  }}
                  onDoubleClick={() => level === 'files' && open(node.id, 1)}
                >
                  <Icon name={node.external ? 'globe' : level === 'files' ? 'file' : 'folder'} />
                  {node.label}
                </div>
              )
            })}
            {unresolved.map((item, i) => {
              const box = drawn.pos.get(unresolvedId(i))
              return (
                box && (
                  <div key={i} className="gn ghost" style={{ left: box.x, top: box.y }}>
                    <Icon name="x" />
                    {item.import.specifier} <span className="dim">unresolved</span>
                  </div>
                )
              )
            })}
          </div>
          {nodes.length === 1 && level === 'packages' && (
            <div className="banner sky gone" onClick={(e) => e.stopPropagation()}>
              <Icon name="network" />
              <span className="grow">One package. Try Folders or Files to see how it is wired inside.</span>
              <button className="btn sm" onClick={() => setLevel('folders')}>Folders</button>
            </div>
          )}
          {!nodes.length && <div className="empty gempty">Nothing matches {query}.</div>}
        </div>
        <div className="gside">
          {nodes.length > 1 && (
            <>
              <div className="sec">Why does A import B?</div>
              <div className="box">
                <select value={from} onChange={(e) => setEnds([e.target.value, to])}>
                  {nodes.map((node) => (
                    <option key={node.id} value={node.id}>{node.label}</option>
                  ))}
                </select>
                <select value={to} onChange={(e) => setEnds([from, e.target.value])}>
                  {nodes.map((node) => (
                    <option key={node.id} value={node.id}>{node.label}</option>
                  ))}
                </select>
                <button
                  className="btn sm pri"
                  onClick={() => {
                    setSelected(null)
                    setPath(findPath(edges, from, to))
                  }}
                >
                  <Icon name="search" />
                  Find path
                </button>
                {path && !path.length && <div className="dim gnote">No import path: {label(to)} is not reachable from {label(from)}.</div>}
                {path && path.length > 0 && (
                  <div className="gnote">
                    {path.slice(1).map((target, i) => {
                      const edge = edges.find((e) => e.from === path[i] && e.to === target)
                      const first = edge?.imports[0]
                      return (
                        <div key={target} className="hop">
                          {label(path[i])} <span className="dim">→</span> {label(target)}
                          {first && (
                            <div className="ev" onClick={() => open(first.from, first.line)}>
                              {first.from}:{first.line} {first.kind === 'type' ? 'import type' : first.kind === 'dynamic' ? 'import()' : first.kind === 'require' ? 'require' : 'import'} '{first.specifier}'
                              {edge.imports.length > 1 && ` and ${edge.imports.length - 1} more`}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </>
          )}
          <div className="sec">
            Cycles <span className={cycles.length ? 'tag red' : 'tag'}>{cycles.length}</span>
          </div>
          <div className="box">
            {cycles.map((group) => (
              <div key={group.join('>')} className="hop grow-row">
                <span className="grow">{group.map(label).join(' ⇄ ')}</span>
                <button className="btn sm" onClick={() => (setSelected(null), setPath(group))}>Show</button>
              </div>
            ))}
            {!cycles.length && <span className="dim">None</span>}
            <div className="dim gsmall">type-only imports never count as cycles</div>
          </div>
          <div className="sec">
            Unresolved imports <span className={unresolved.length ? 'tag red' : 'tag'}>{unresolved.length}</span>
          </div>
          <div className="box">
            {unresolved.map(({ import: item }, i) => (
              <div key={i} className="hop">
                <span className="err mono">{item.specifier}</span>
                <div className="ev" onClick={() => open(item.from, item.line)}>
                  {item.from}:{item.line}
                </div>
              </div>
            ))}
            {!unresolved.length && <span className="dim">None</span>}
          </div>
          {scan.graph.errors.length > 0 && (
            <>
              <div className="sec">
                Could not parse <span className="tag red">{scan.graph.errors.length}</span>
              </div>
              <div className="box">
                {scan.graph.errors.map(([file, message]) => (
                  <div key={file} className="hop">
                    <span className="mono">{file}</span>
                    <div className="ev" onClick={() => open(file, 1)}>{message}</div>
                  </div>
                ))}
              </div>
            </>
          )}
          {selected && (
            <>
              <div className="sec">Selected</div>
              <div className="box">
                <b className="mono">{label(selected)}</b>
                <div className="dim gnote">
                  imports {edges.filter((e) => e.from === selected).length} · imported by {edges.filter((e) => e.to === selected).length}
                </div>
                {level === 'files' && (
                  <button className="btn sm gnote" onClick={() => open(selected, 1)}>
                    <Icon name="file" />
                    Open
                  </button>
                )}
              </div>
            </>
          )}
          <div className="sec">Legend</div>
          <div className="box glg">
            <span><i />import</span>
            <span><i className="type" />type-only</span>
            <span><i className="dyn" />import()</span>
            <span><i className="cyc" />cycle</span>
            <span><i className="unres" />unresolved</span>
          </div>
        </div>
      </div>
    </div>
  )
}

