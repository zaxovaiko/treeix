import type { MainContext } from '@treeix/sdk/main'
import type { Credentials, CredentialsStatus } from '../shared'
import { signedInEmail } from './cli'
import { loadCredentials, saveCredentials } from './credentials'
import { loadImage } from './images'

/** Image and API token handlers every Atlassian plugin registers under its own id */
export function handleAtlassianShared(context: MainContext): void {
  context.handle('image', (_, source: string) => loadImage(source))
  // The token only goes in; the renderer learns whether one is stored, never the token itself
  context.handle('credentials', async (): Promise<CredentialsStatus> => {
    const stored = await loadCredentials()
    return { email: stored?.email ?? (await signedInEmail()), hasToken: stored !== null }
  })
  context.handle('saveCredentials', (_, credentials: Credentials | null) => saveCredentials(credentials))
}
