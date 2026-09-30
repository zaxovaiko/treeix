import { isReviewComment, type ReviewComment } from '../../shared/comments'
import { list } from '../../shared/json'
import { readStored } from './storage'

/** Comments taken off the list when they went to an agent, kept so they can be brought back */
export type SentBatch = { id: string; sentAt: string; worktreePath: string; message: string; comments: ReviewComment[] }

const KEY = 'comments.sent'
const LIMIT = 30

const isSentBatch = (value: unknown): value is SentBatch => {
  if (typeof value !== 'object' || value === null) return false
  const batch = value as Partial<SentBatch>
  return typeof batch.id === 'string' && typeof batch.sentAt === 'string' && typeof batch.worktreePath === 'string' && typeof batch.message === 'string' && Array.isArray(batch.comments) && batch.comments.every(isReviewComment)
}

export const loadSent = (): SentBatch[] => list(readStored(KEY), isSentBatch)

export const saveSent = (batches: SentBatch[]): void => localStorage.setItem(KEY, JSON.stringify(batches))

/** Newest first; the oldest drop out past the limit */
export const addSent = (batches: SentBatch[], batch: SentBatch): SentBatch[] => [batch, ...batches].slice(0, LIMIT)

/** The batch's comments back on the list, skipping any still there; the batch leaves the history */
export function restoreSent(batches: SentBatch[], comments: ReviewComment[], id: string): { batches: SentBatch[]; comments: ReviewComment[] } {
  const batch = batches.find((candidate) => candidate.id === id)
  if (!batch) return { batches, comments }
  const present = new Set(comments.map((comment) => comment.id))
  return { batches: batches.filter((candidate) => candidate.id !== id), comments: [...comments, ...batch.comments.filter((comment) => !present.has(comment.id))] }
}
