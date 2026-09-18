/** A folder in a file tree; chains of single-child folders are merged into one node, like VS Code's compact folders */
export type FolderNode<T> = { name: string; path: string; folders: FolderNode<T>[]; files: T[] }

export function buildFolderTree<T>(items: T[], pathOf: (item: T) => string): FolderNode<T> {
  const root: FolderNode<T> = { name: '', path: '', folders: [], files: [] }
  for (const item of items) {
    const parts = pathOf(item).split('/').slice(0, -1)
    let node = root
    parts.forEach((part, index) => {
      let child = node.folders.find((folder) => folder.name === part)
      if (!child) {
        child = { name: part, path: parts.slice(0, index + 1).join('/'), folders: [], files: [] }
        node.folders.push(child)
      }
      node = child
    })
    node.files.push(item)
  }
  const compact = (node: FolderNode<T>): FolderNode<T> => {
    let current = node
    while (current.folders.length === 1 && current.files.length === 0) {
      const [only] = current.folders
      current = { ...only, name: `${current.name}/${only.name}` }
    }
    return { ...current, folders: current.folders.map(compact).sort((a, b) => a.name.localeCompare(b.name)) }
  }
  return { ...root, folders: root.folders.map(compact).sort((a, b) => a.name.localeCompare(b.name)) }
}

/** Every folder path that contains `filePath`, including merged chain paths, so the file can be revealed */
export const ancestorFolders = (filePath: string): string[] =>
  filePath
    .split('/')
    .slice(0, -1)
    .map((_, index, parts) => parts.slice(0, index + 1).join('/'))
