import { Icon } from '@treeix/app/Icon'
import { IconButton } from '@treeix/app/ui'
import { createBridge, useHost } from '@treeix/sdk'
import { activePane } from './terminals'

const bridge = createBridge('terminal')

const folderLabel = (path: string, home: string): string => (path === home ? '~' : (path.split('/').pop() ?? path))

/** What the files panel shows, with buttons to browse the terminal's folder or any other */
function ExplorerHeader(): React.JSX.Element {
  const host = useHost()
  const label = host.browsedFolder ? folderLabel(host.browsedFolder, window.api.home) : (host.selectedWorktreeLabel ?? '~')
  const showTerminalFolder = async (): Promise<void> => {
    const session = activePane()
    const cwd = session ? await bridge.invoke<string | null>('cwd', session.id) : null
    if (cwd) host.setBrowsedFolder(cwd)
    else host.flash('No running terminal to take the folder from')
  }
  const pickFolder = async (): Promise<void> => {
    const folder = await window.api.pickFolder()
    if (folder) host.setBrowsedFolder(folder)
  }
  return (
    <div className="flex h-8 shrink-0 items-center gap-0.5 border-t border-border pr-1.5 pl-3">
      <span className="shrink-0 text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase">Files</span>
      <span title={host.explorerRoot} className="min-w-0 flex-1 truncate pl-1.5 text-[11px] text-muted-foreground">
        {label}
      </span>
      <IconButton label="Show the terminal's folder" onClick={showTerminalFolder}>
        <Icon name="terminal" className="size-3.5" />
      </IconButton>
      <IconButton label="Open folder…" onClick={pickFolder}>
        <Icon name="folderOpen" className="size-3.5" />
      </IconButton>
      {host.browsedFolder && (
        <IconButton label={host.selectedWorktree ? 'Back to the selected worktree' : 'Back to home'} onClick={() => host.setBrowsedFolder(null)}>
          <Icon name="close" className="size-3" />
        </IconButton>
      )}
    </div>
  )
}

/** The file explorer; closed sessions live under the group list */
export function Inspector({
  previewPath,
  onOpenFile
}: {
  /** The file in the preview, highlighted in the explorer */
  previewPath: string | null
  onOpenFile: (path: string, root: string) => void
}): React.JSX.Element {
  const host = useHost()
  return (
    <>
      <ExplorerHeader />
      <div className="min-h-0 flex-1">{host.renderExplorer(previewPath, (path) => onOpenFile(path, host.explorerRoot))}</div>
    </>
  )
}
