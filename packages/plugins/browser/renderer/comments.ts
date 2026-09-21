import type { Attachment, ReviewComment } from '@treeix/shared/comments'
import type { ConsoleEntry, ElementSelection, NetworkEntry, Vital } from '../shared/types'

/** Stable per row, so unticking a row finds the comment it added */
export const entryCommentId = (entry: ConsoleEntry | NetworkEntry | Vital): string => `browser:${entry.kind}:${entry.id}`

const item = (id: string, pageUrl: string, worktreePath: string, text: string, body: string, attachments?: Attachment[]): ReviewComment => ({
  id,
  worktreePath,
  filePath: pageUrl,
  range: { start: 0, end: 0 },
  code: '',
  text,
  body,
  kind: 'browser',
  ...(attachments ? { attachments } : {})
})

export const elementComment = (selection: ElementSelection, note: string, worktreePath: string, attachment?: Attachment): ReviewComment =>
  item(
    crypto.randomUUID(),
    selection.url,
    worktreePath,
    note,
    [`Element: ${selection.selector}`, ...(selection.text ? [`Text: ${selection.text}`] : []), `HTML: ${selection.html}`].join('\n'),
    attachment ? [attachment] : undefined
  )

export const consoleComment = (entry: ConsoleEntry, pageUrl: string, worktreePath: string): ReviewComment =>
  item(entryCommentId(entry), pageUrl, worktreePath, `Console ${entry.level}: ${entry.text}`, entry.stack || entry.source)

const headers = (title: string, values: Record<string, string>): string[] => {
  const lines = Object.entries(values).map(([name, value]) => `${name}: ${value}`)
  return lines.length ? [`${title}:\n${lines.join('\n')}`] : []
}

export function networkComment(entry: NetworkEntry, responseBody: string | null, pageUrl: string, worktreePath: string): ReviewComment {
  const outcome = entry.failed ?? (entry.status === null ? 'no response' : String(entry.status))
  const timing = entry.durationMs === null ? '' : ` in ${Math.round(entry.durationMs)} ms`
  const broken = entry.failed !== null || (entry.status ?? 0) >= 400
  const body = [
    ...headers('Request headers', entry.requestHeaders),
    ...(entry.postData ? [`Request body:\n${entry.postData}`] : []),
    ...headers('Response headers', entry.responseHeaders),
    ...(responseBody ? [`Response body:\n${responseBody}`] : [])
  ].join('\n\n')
  return item(entryCommentId(entry), pageUrl, worktreePath, `${broken ? 'Request failed' : 'Request'}: ${entry.method} ${entry.url}, ${outcome}${timing}`, body)
}

const vitalValue = (vital: Vital): string => (vital.name === 'CLS' ? String(Math.round(vital.value * 100) / 100) : `${Math.round(vital.value)} ms`)

export const vitalComment = (vital: Vital, pageUrl: string, worktreePath: string): ReviewComment =>
  item(entryCommentId(vital), pageUrl, worktreePath, `Performance: ${vital.name} ${vitalValue(vital)}`, vital.element ? `Caused by: ${vital.element}` : '')
