import { useSyncExternalStore } from 'react'

export interface LineRange {
  start: number
  end: number
}

/** A note for the agent on lines of a file; Phase 4 sends them. Same shape and storage key as the Electron app's file comments */
export interface ReviewComment {
  id: string
  worktreePath: string
  filePath: string
  range: LineRange
  /** The commented lines, shown in the app only; prompts carry `path:line` */
  code: string
  text: string
  kind: 'file'
}

export const COMMENTS_KEY = 'comments'

export function extractFileLines(contents: string, { start, end }: LineRange): string {
  return contents
    .split('\n')
    .slice(Math.min(start, end) - 1, Math.max(start, end))
    .join('\n')
}

export const rangeLabel = ({ start, end }: LineRange): string => (start === end ? `${start}` : `${Math.min(start, end)}-${Math.max(start, end)}`)

/** "Line 4" or "Lines 4-9" */
export const linesLabel = (range: LineRange): string => `${range.start === range.end ? 'Line' : 'Lines'} ${rangeLabel(range)}`

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
    candidate.kind === 'file'
  )
}

function read(): ReviewComment[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(COMMENTS_KEY) ?? '[]')
    return Array.isArray(stored) ? stored.filter(isReviewComment) : []
  } catch {
    return []
  }
}

let comments: ReviewComment[] | null = null
const listeners = new Set<() => void>()

export const getComments = (): ReviewComment[] => (comments ??= read())

function setComments(next: ReviewComment[]): void {
  comments = next
  localStorage.setItem(COMMENTS_KEY, JSON.stringify(next))
  listeners.forEach((listener) => listener())
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

export const useComments = (): ReviewComment[] => useSyncExternalStore(subscribe, getComments)

export const addComment = (comment: Omit<ReviewComment, 'id' | 'kind'>): void => setComments([...getComments(), { ...comment, id: crypto.randomUUID(), kind: 'file' }])
export const deleteComment = (id: string): void => setComments(getComments().filter((comment) => comment.id !== id))
export const clearComments = (worktreePath: string): void => setComments(getComments().filter((comment) => comment.worktreePath !== worktreePath))
