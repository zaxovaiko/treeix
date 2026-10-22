import { parseDiffFromFile } from '@pierre/diffs'

/** Removed lines sit after line `after` (0: above the first line) */
export interface Removal {
  after: number
  lines: string[]
}

export interface GutterMarks {
  added: number[]
  modified: number[]
  removed: Removal[]
}

/** What the editor's gutter shows against the base: added, modified and removed lines, by new-file line number */
export function gutterMarks(base: string, current: string): GutterMarks {
  const marks: GutterMarks = { added: [], modified: [], removed: [] }
  if (base === current) return marks
  const diff = parseDiffFromFile({ name: 'base', contents: base }, { name: 'current', contents: current })
  for (const hunk of diff.hunks) {
    for (const block of hunk.hunkContent) {
      if (block.type !== 'change') continue
      const lines = Array.from({ length: block.additions }, (_, i) => block.additionLineIndex + i + 1)
      if (!block.additions) {
        marks.removed.push({ after: block.additionLineIndex, lines: diff.deletionLines.slice(block.deletionLineIndex, block.deletionLineIndex + block.deletions).map((line) => line.replace(/\r?\n$/, '')) })
      } else marks[block.deletions ? 'modified' : 'added'].push(...lines)
    }
  }
  return marks
}
