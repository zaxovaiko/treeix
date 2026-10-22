import { useEffect, useState, type MouseEvent, type ReactNode } from 'react'
import type { ChangeStatus, GitStatus, Place } from '../ipc/api'
import { Icon } from '../lib/icons'
import { tilde } from '../shell/model'
import type { ShellView } from '../shell/Shell'
import { Head, Menu, NoFolder, PIcon, type MenuItem } from './common'
import { isIgnored, STATUS_CLASS, STATUS_LETTER } from './logic'

const FILTER_LIMIT = 300

/** A new file / folder name typed into the tree, or a rename */
type Edit = { mode: 'file' | 'folder'; dir: string } | { mode: 'rename'; path: string }

const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')))
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/** Keyed by the place's path, so switching places starts fresh */
export function Explorer({ view, place, status, tick }: { view: ShellView; place: Place; status: GitStatus | null; tick: number }) {
  const { api } = view
  const root = place.path
  const scratch = place.kind === 'scratch'
  const [open, setOpen] = useState<string[]>([])
  const [dirs, setDirs] = useState<Record<string, string[]>>({})
  const [files, setFiles] = useState<{ files: string[]; ignored: Set<string> }>({ files: [], ignored: new Set() })
  const [q, setQ] = useState('')
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; items: MenuItem[] } | null>(null)
  const [edit, setEdit] = useState<Edit | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  // Lazy: only the root and expanded folders are listed
  useEffect(() => {
    if (scratch) return
    let live = true
    const folders = ['', ...open]
    void Promise.all(folders.map((f) => api.listDirectory(root, f).catch(() => []))).then((lists) => {
      if (live) setDirs(Object.fromEntries(folders.map((f, i) => [f, lists[i]])))
    })
    return () => void (live = false)
  }, [api, root, scratch, open, tick])

  // Whole list for the ignored marks and the filter
  useEffect(() => {
    if (scratch) return
    let live = true
    void api
      .listFiles(root)
      .catch(() => null)
      .then((list) => live && setFiles({ files: list?.files ?? [], ignored: new Set(list?.ignored ?? []) }))
    return () => void (live = false)
  }, [api, root, scratch, tick])

  if (scratch)
    return (
      <>
        <Head title="Explorer" place={place} />
        <NoFolder view={view} what="are no files to show" />
      </>
    )

  const changes = new Map<string, ChangeStatus>((status?.changes ?? []).map((c) => [c.path, c.status]))
  const conflicts = new Set(status?.conflicts ?? [])
  const statusOf = (path: string): ChangeStatus | undefined => (conflicts.has(path) ? 'conflicted' : changes.get(path))
  const dirtyClass = (dir: string) => {
    const inner = [...changes.keys()].filter((p) => p.startsWith(`${dir}/`))
    return inner.some((p) => conflicts.has(p)) ? 'gs-C' : inner.length ? 'gs-M' : ''
  }

  const toggle = (dir: string) => setOpen(open.includes(dir) ? open.filter((d) => d !== dir && !d.startsWith(`${dir}/`)) : [...open, dir])
  const openFile = (path: string) => {
    setSelected(path)
    view.openFile(root, path)
  }
  const attempt = (call: Promise<void>) => call.then(() => setError(null), (e: unknown) => setError(String(e)))

  const submit = (name: string) => {
    const current = edit
    setEdit(null)
    const clean = name.trim().replace(/^\/+|\/+$/g, '')
    if (!current || !clean) return
    if (current.mode === 'rename') {
      const to = parentOf(current.path) ? `${parentOf(current.path)}/${clean}` : clean
      if (to !== current.path) void attempt(api.renamePath(root, current.path, to))
      return
    }
    const path = current.dir ? `${current.dir}/${clean}` : clean
    void attempt(api.createPath(root, current.mode === 'folder' ? `${path}/` : path)).then(() => current.mode === 'file' && openFile(path))
  }
  const create = (mode: 'file' | 'folder', dir: string) => {
    if (dir && !open.includes(dir)) setOpen([...open, dir])
    setEdit({ mode, dir })
  }

  const itemsFor = (path: string | null, dir: boolean): MenuItem[] => {
    const into = path === null ? '' : dir ? path : parentOf(path)
    const items: MenuItem[] = [
      { label: 'New file', icon: 'file', run: () => create('file', into) },
      { label: 'New folder', icon: 'folder', run: () => create('folder', into) },
    ]
    const full = path === null ? root : `${root}/${path}`
    if (path !== null) items.push({ label: 'Rename', run: () => setEdit({ mode: 'rename', path }) })
    items.push(
      { label: 'Copy path', run: () => void navigator.clipboard.writeText(full) },
      { label: 'Reveal in Finder', run: () => void api.revealInFinder(full) },
    )
    if (path !== null) items.push({ label: 'Move to Trash', danger: true, run: () => void attempt(api.trashPath(root, path)) })
    return items
  }
  const onMenu = (e: MouseEvent, path: string | null, dir: boolean) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ at: { x: e.clientX, y: e.clientY }, items: itemsFor(path, dir) })
  }

  const nameInput = (depth: number, initial: string, folder: boolean) => (
    <div className="frow" style={{ paddingLeft: (folder ? 6 : 24) + depth * 12 }}>
      {folder && <Icon name="down" className="chev closed" />}
      {folder ? <Icon name="folder" /> : <PIcon name="file" />}
      <input
        className="fname"
        autoFocus
        defaultValue={initial}
        onFocus={(e) => e.currentTarget.setSelectionRange(0, initial.lastIndexOf('.') > 0 ? initial.lastIndexOf('.') : initial.length)}
        onKeyDown={(e) => {
          // Both end in blur, which submits once; an emptied name is a cancel
          if (e.key === 'Escape') e.currentTarget.value = ''
          if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
        }}
        onBlur={(e) => submit(e.currentTarget.value)}
      />
    </div>
  )

  const rows: ReactNode[] = []
  const walk = (folder: string, depth: number) => {
    if (edit && edit.mode !== 'rename' && edit.dir === folder) rows.push(<div key={`new:${folder}`}>{nameInput(depth, '', edit.mode === 'folder')}</div>)
    for (const entry of dirs[folder] ?? []) {
      const isDir = entry.endsWith('/')
      const name = entry.replace(/\/$/, '')
      const path = folder ? `${folder}/${name}` : name
      if (edit?.mode === 'rename' && edit.path === path) {
        rows.push(<div key={path}>{nameInput(depth, name, isDir)}</div>)
        continue
      }
      const ignored = isIgnored(isDir ? `${path}/` : path, files.ignored)
      if (isDir) {
        const expanded = open.includes(path)
        const dirty = ignored ? '' : dirtyClass(path)
        rows.push(
          <div key={path} className={`frow ${ignored ? 'gs-I' : ''}`} style={{ paddingLeft: 6 + depth * 12 }} onClick={() => toggle(path)} onContextMenu={(e) => onMenu(e, path, true)} title={ignored ? 'Ignored by .gitignore' : undefined}>
            <Icon name="down" className={`chev ${expanded ? '' : 'closed'}`} />
            <Icon name={expanded ? 'folderOpen' : 'folder'} />
            <span className={`trunc ${dirty}`}>{name}</span>
            {dirty && <i className="fdot" />}
          </div>,
        )
        if (expanded) walk(path, depth + 1)
        continue
      }
      const s = statusOf(path)
      rows.push(
        <div
          key={path}
          className={`frow ${s ? STATUS_CLASS[s] : ignored ? 'gs-I' : ''} ${selected === path ? 'on' : ''}`}
          style={{ paddingLeft: 24 + depth * 12 }}
          onClick={() => openFile(path)}
          onContextMenu={(e) => onMenu(e, path, false)}
          title={ignored ? 'Ignored by .gitignore' : undefined}
        >
          <PIcon name="file" />
          <span className="trunc">{name}</span>
          {s && <span className="st">{STATUS_LETTER[s]}</span>}
        </div>,
      )
    }
  }

  const query = q.trim().toLowerCase()
  if (query)
    for (const path of files.files.filter((f) => baseName(f).toLowerCase().includes(query)).slice(0, FILTER_LIMIT)) {
      const s = statusOf(path)
      rows.push(
        <div key={path} className={`frow ${s ? STATUS_CLASS[s] : ''} ${selected === path ? 'on' : ''}`} style={{ paddingLeft: 12 }} onClick={() => openFile(path)} onContextMenu={(e) => onMenu(e, path, false)}>
          <PIcon name="file" />
          <span className="trunc">
            {baseName(path)} <span className="d">{parentOf(path)}</span>
          </span>
          {s && <span className="st">{STATUS_LETTER[s]}</span>}
        </div>,
      )
    }
  else walk('', 0)

  return (
    <>
      <Head title="Explorer" place={place}>
        <button className="icon sm" onClick={() => create('file', '')} title="New file">
          <Icon name="plus" />
        </button>
        <button className="icon sm" onClick={() => setOpen([])} title="Collapse folders">
          <PIcon name="collapse" />
        </button>
      </Head>
      <div className="dim mono ppath trunc">{tilde(root, view.home)}</div>
      <label className="filter">
        <Icon name="search" />
        <input placeholder="Filter files" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQ('')} />
      </label>
      {error && (
        <div className="banner red">
          <Icon name="alert" />
          <span className="grow">{error}</span>
          <button className="icon sm" onClick={() => setError(null)} title="Dismiss">
            <Icon name="x" />
          </button>
        </div>
      )}
      <div className="pscroll" onContextMenu={(e) => onMenu(e, null, true)}>
        {rows.length ? rows : <div className="empty">{query ? 'No files match' : 'Empty folder'}</div>}
      </div>
      {menu && <Menu at={menu.at} items={menu.items} onClose={() => setMenu(null)} />}
    </>
  )
}
