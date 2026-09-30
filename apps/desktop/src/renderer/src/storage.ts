import { parseJson } from '../../shared/json'

/** A stored JSON value, or null when missing, unreadable or without storage (bun tests); callers narrow it */
export const readStored = (key: string): unknown => (typeof localStorage === 'undefined' ? null : parseJson(localStorage.getItem(key)))
