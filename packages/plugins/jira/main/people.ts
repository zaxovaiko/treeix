import { restFetch } from '@treeix/atlassian/main/cli'
import { loadCredentials } from '@treeix/atlassian/main/credentials'
import { object, text } from '@treeix/atlassian/shared'
import type { JiraPerson } from '../shared/types'
import { avatarOf, checkedKey } from './acli'

// Apart from acli.ts: the API token lives in Electron's safeStorage, which tests can't load
/** People Jira allows on this item, matching `query`; empty without an API token, where the list's own people stand in */
export async function assignableUsers(key: string, query: string): Promise<JiraPerson[]> {
  const credentials = await loadCredentials()
  if (!credentials) return []
  const response = await restFetch(`/rest/api/3/user/assignable/search?issueKey=${encodeURIComponent(checkedKey(key))}&query=${encodeURIComponent(query)}&maxResults=50`, credentials)
  const users: unknown = await response.json()
  return (Array.isArray(users) ? users : [])
    .map(object)
    .filter((user) => text(user.accountType) !== 'app')
    .map((user) => ({ accountId: text(user.accountId), name: text(user.displayName), avatar: avatarOf(user) }))
    .filter((person) => person.accountId && person.name)
}

