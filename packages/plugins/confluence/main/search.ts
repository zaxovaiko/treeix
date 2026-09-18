import { isJson, object, orNull, text } from '@treeix/atlassian/shared'
import type { PageSummary } from '../shared/types'

/** Search results from the REST API, which acli has no command for */
export function toPageSummaries(raw: unknown): PageSummary[] {
  const results = object(raw).results
  return (Array.isArray(results) ? results.filter(isJson) : []).map((result) => ({
    id: text(object(result.content).id),
    title: text(object(result.content).title) || text(result.title),
    space: orNull(text(object(result.resultGlobalContainer).title)),
    lastModified: orNull(text(result.lastModified))
  })).filter((page) => page.id)
}

/** CQL string literal */
export const cqlString = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
