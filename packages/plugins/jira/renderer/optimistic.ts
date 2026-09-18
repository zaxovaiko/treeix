import type { WorkItem } from '../shared/types'

/** A change shown before Jira confirms it, by item key */
export type Patches = Record<string, { fields: Partial<WorkItem>; at: number }>

/** Jira's search index lags a few seconds behind edits, so a patch outlives the first refresh until the list agrees or this passes */
export const PATCH_TTL_MS = 60_000

export const applyPatch = (item: WorkItem, patches: Patches): WorkItem => (patches[item.key] ? { ...item, ...patches[item.key].fields } : item)

/** Patches still needed: dropped once the fetched list shows the same values, or when they are too old to trust */
export function pendingPatches(items: WorkItem[], patches: Patches, now: number): Patches {
  return Object.fromEntries(
    Object.entries(patches).filter(([key, patch]) => {
      if (now - patch.at > PATCH_TTL_MS) return false
      const item = items.find((candidate) => candidate.key === key)
      return !item || Object.entries(patch.fields).some(([field, value]) => item[field as keyof WorkItem] !== value)
    })
  )
}
