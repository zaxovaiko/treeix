// Its own module so @pierre/diffs loads with the file history, not at startup
import { parseDiffFromFile, parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs'

export type DiffRow = { kind: 'hunk' | 'add' | 'del' | 'ctx'; text: string }

const strip = (line: string | undefined) => (line ?? '').replace(/\r?\n$/, '')

function rowsOf(file: FileDiffMetadata): DiffRow[] {
  const rows: DiffRow[] = []
  for (const hunk of file.hunks) {
    rows.push({ kind: 'hunk', text: strip(hunk.hunkSpecs) })
    for (const part of hunk.hunkContent) {
      if (part.type === 'context') {
        for (let i = 0; i < part.lines; i++) rows.push({ kind: 'ctx', text: strip(file.additionLines[part.additionLineIndex + i]) })
        continue
      }
      for (let i = 0; i < part.deletions; i++) rows.push({ kind: 'del', text: strip(file.deletionLines[part.deletionLineIndex + i]) })
      for (let i = 0; i < part.additions; i++) rows.push({ kind: 'add', text: strip(file.additionLines[part.additionLineIndex + i]) })
    }
  }
  return rows
}

/** Rows of a `diff --git` patch (a commit's change) */
export const patchRows = (patch: string): DiffRow[] => (patch ? parsePatchFiles(patch).flatMap((p) => p.files.flatMap(rowsOf)) : [])

/** Rows from one version to another (a local save vs the file now) */
export const versionRows = (name: string, before: string, after: string): DiffRow[] => rowsOf(parseDiffFromFile({ name, contents: before }, { name, contents: after }))
