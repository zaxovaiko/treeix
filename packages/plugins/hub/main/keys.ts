import { createSecrets } from '@treeix/host/secrets'

/** API keys by URL origin, so every agent on one provider shares its key */
export function createKeys(path: string): { get: (baseUrl: string) => Promise<string | null>; set: (baseUrl: string, key: string | null) => Promise<void> } {
  const secrets = createSecrets(path)
  return {
    get: (baseUrl) => secrets.get(new URL(baseUrl).origin),
    set: (baseUrl, key) => secrets.set(new URL(baseUrl).origin, key)
  }
}
