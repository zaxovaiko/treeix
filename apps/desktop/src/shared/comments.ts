export type Side = 'deletions' | 'additions'

export type LineRange = {
  start: number
  end: number
  side?: Side
  endSide?: Side
}

export type Attachment = {
  /** Absolute path of the stored copy, which is what agents read */
  path: string
  name: string
  /** Small data URL preview for images */
  thumbnail?: string
}

export type ReviewComment = {
  id: string
  worktreePath: string
  filePath: string
  range: LineRange
  code: string
  text: string
  /** Comment on a whole file view rather than a diff; ranges have no side */
  kind?: 'file'
  attachments?: Attachment[]
}

type PatchRow = { old: number | null; new: number | null; text: string }

function patchRows(patch: string): PatchRow[] {
  const rows: PatchRow[] = []
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  for (const text of patch.split('\n')) {
    const header = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (header) {
      oldLine = Number(header[1])
      newLine = Number(header[2])
      inHunk = true
    } else if (!inHunk || text.startsWith('\\')) {
      continue
    } else if (text.startsWith('-')) {
      rows.push({ old: oldLine++, new: null, text })
    } else if (text.startsWith('+')) {
      rows.push({ old: null, new: newLine++, text })
    } else if (text.startsWith(' ')) {
      rows.push({ old: oldLine++, new: newLine++, text })
    }
  }
  return rows
}

export function extractLines(patch: string, range: LineRange): string {
  const rows = patchRows(patch)
  const startSide = range.side ?? 'additions'
  const find = (side: Side, line: number): number =>
    rows.findIndex((row) => (side === 'deletions' ? row.old : row.new) === line)
  const from = find(startSide, range.start)
  const to = find(range.endSide ?? startSide, range.end)
  if (from === -1 || to === -1) return ''
  return rows
    .slice(Math.min(from, to), Math.max(from, to) + 1)
    .map((row) => row.text)
    .join('\n')
}

export function extractFileLines(contents: string, { start, end }: LineRange): string {
  return contents
    .split('\n')
    .slice(Math.min(start, end) - 1, Math.max(start, end))
    .join('\n')
}

export function rangeLabel({ start, end, side, endSide }: LineRange): string {
  const lines = start === end ? `${start}` : `${Math.min(start, end)}-${Math.max(start, end)}`
  const onlyDeletions = side === 'deletions' && (endSide ?? side) === 'deletions'
  return onlyDeletions ? `${lines} (old)` : lines
}

/** Line 0 means the comment is about the whole file or PR, not specific lines */
export const commentLocation = (comment: ReviewComment): string =>
  comment.range.start > 0 ? `${comment.filePath}:${rangeLabel(comment.range)}` : comment.filePath

export function formatComments(comments: ReviewComment[]): string {
  return comments
    .map((comment, index) =>
      [
        `${index + 1}. ${commentLocation(comment)}`,
        ...(comment.code ? [comment.kind === 'file' ? '```' : '```diff', comment.code, '```'] : []),
        comment.text.trim(),
        ...(comment.attachments?.length ? ['Attached files:', ...comment.attachments.map((file) => `- ${file.path}`)] : [])
      ].join('\n')
    )
    .join('\n\n')
}

function isAttachment(value: unknown): value is Attachment {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.path === 'string' &&
    typeof candidate.name === 'string' &&
    (candidate.thumbnail === undefined || typeof candidate.thumbnail === 'string')
  )
}

export function isReviewComment(value: unknown): value is ReviewComment {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  const range = candidate.range as Record<string, unknown> | null
  return (
    ['id', 'worktreePath', 'filePath', 'code', 'text'].every((key) => typeof candidate[key] === 'string') &&
    typeof range === 'object' &&
    range !== null &&
    typeof range.start === 'number' &&
    typeof range.end === 'number' &&
    (candidate.kind === undefined || candidate.kind === 'file') &&
    (candidate.attachments === undefined || (Array.isArray(candidate.attachments) && candidate.attachments.every(isAttachment)))
  )
}
