import { createBridge } from '@treeix/sdk'
import { type Credentials, type CredentialsStatus, IMAGE_HOST, type ImageResult } from '../shared'

export type AtlassianBridge = {
  invoke: ReturnType<typeof createBridge>['invoke']
  credentials: () => Promise<CredentialsStatus>
  saveCredentials: (credentials: Credentials | null) => Promise<void>
  /** Attachment images go through the main process, which holds the API token; other images load as they are */
  resolveImage: (src: string) => Promise<string> | null
}

export function atlassianBridge(pluginId: string): AtlassianBridge {
  const bridge = createBridge(pluginId)
  return {
    invoke: bridge.invoke,
    credentials: () => bridge.invoke<CredentialsStatus>('credentials'),
    saveCredentials: (credentials) => bridge.invoke<void>('saveCredentials', credentials),
    resolveImage: (src) =>
      src.startsWith(`${IMAGE_HOST}/`)
        ? bridge.invoke<ImageResult>('image', src).then((result) => {
            if ('error' in result) throw new Error(result.error)
            return result.dataUrl
          })
        : null
  }
}
