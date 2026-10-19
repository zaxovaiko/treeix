import { useEffect, useState } from 'react'
import { Icon } from './Icon'
import { Picker, type PickerOption } from './Picker'
import { worktreeLabel } from './sessionUi'
import { useWorkspaces } from './workspaces'

const BROWSE = 'browse'

// ponytail: one scan of ~ per app run, so repos cloned later need a restart to show up
let found: Promise<string[]> | null = null
const findRepos = (): Promise<string[]> => (found ??= window.api.scan().then((repos) => repos.map((repo) => repo.path).sort()))

function FolderRow({ path }: { path: string }): React.JSX.Element {
  return (
    <span title={path} className="flex min-w-0 items-baseline gap-2">
      <span className="max-w-[60%] shrink-0 truncate text-foreground">{worktreeLabel(null, path)}</span>
      {/* Right to left so a long path keeps its end, the part that tells checkouts apart */}
      <span dir="rtl" className="min-w-0 shrink-[3] truncate text-left text-[11px] text-muted-foreground">
        <bdi>{path.replace(window.api.home, '~')}</bdi>
      </span>
    </span>
  )
}

/** Where a chat runs: a searchable list of the folders chats ran in, the workspaces' projects and every repo under ~; a typed path or Finder reaches the rest */
export function FolderPicker({
  folder,
  recent = [],
  title,
  className,
  placeholder = '',
  stretch = false,
  onPick
}: {
  folder: string
  recent?: string[]
  title: string
  className: string
  /** Shown while no folder is picked */
  placeholder?: string
  /** The trigger fills its row, as a form field */
  stretch?: boolean
  onPick: (folder: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const { workspaces } = useWorkspaces()
  const [repos, setRepos] = useState<string[]>([])
  useEffect(() => {
    if (open) void findRepos().then(setRepos)
  }, [open])
  const home = window.api.home
  const projects = [...new Set([...workspaces.flatMap((workspace) => workspace.repoPaths), ...repos, home])].filter((path) => !recent.includes(path))
  const row =
    (section: string) =>
    (path: string): PickerOption => ({ id: path, label: path, section, render: <FolderRow path={path} /> })
  const action = (id: string, text: string, match: string): PickerOption => ({
    id,
    label: `${text} ${match}`,
    section: '',
    render: <span className="truncate text-muted-foreground">{text}</span>
  })
  // A typed absolute or ~ path is an option of its own, so folders outside the lists are reachable without Finder
  const typed = query.startsWith('~/') ? `${home}${query.slice(1)}` : query.startsWith('/') ? query : null
  const options = [
    ...recent.map(row('Recent')),
    ...projects.map(row('Projects')),
    ...(typed && typed !== folder ? [action(typed, `Go to ${typed.replace(home, '~')}`, query)] : []),
    action(BROWSE, 'Choose in Finder…', 'browse')
  ]
  const pick = (id: string): void => {
    if (id !== BROWSE) return onPick(id)
    void window.api.pickFolder().then((path) => path && onPick(path))
  }
  return (
    <Picker
      trigger={
        <span className={className}>
          <Icon name="folder" className="size-3 shrink-0" />
          <span className={`min-w-0 flex-1 truncate ${folder ? '' : 'text-muted-foreground/60'}`}>{folder ? worktreeLabel(null, folder) : placeholder}</span>
          <Icon name="chevron" className="size-3 shrink-0 rotate-90 opacity-65" />
        </span>
      }
      title={`${title}: ${folder}`}
      options={options}
      current={folder}
      placeholder="Search folders or type a path"
      open={open}
      onOpenChange={setOpen}
      onQuery={setQuery}
      onPick={pick}
      width="w-96"
      stretch={stretch}
    />
  )
}
