import type { WorkItem } from '../shared/types'

/** Branch names for a work item, e.g. OPN-412-rate-limit-behind-proxy */
export const branchFor = (item: WorkItem): string =>
  `${item.key}-${item.summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-$/, '')}`

/** Whether a branch was made for the work item: its key, not a longer one like OPN-412 for OPN-41 */
export const isBranchFor = (branch: string | null, key: string): boolean => new RegExp(`(^|[^a-z0-9])${key}(?!\\d)`, 'i').test(branch ?? '')
