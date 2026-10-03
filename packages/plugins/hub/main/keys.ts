import { safeStorage } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { parseJson, stringValues } from '@treeix/shared/json'

/** API keys by URL origin, so every agent on one provider shares its key; encrypted with the OS keychain key */
export function createKeys(path: string): { get: (baseUrl: string) => Promise<string | null>; set: (baseUrl: string, key: string | null) => Promise<void> } {
  const read = async (): Promise<Record<string, string>> => {
    try {
      return stringValues(parseJson(safeStorage.decryptString(await readFile(path))))
    } catch {
      return {}
    }
  }
  return {
    get: async (baseUrl) => (await read())[new URL(baseUrl).origin] ?? null,
    set: async (baseUrl, key) => {
      const origin = new URL(baseUrl).origin
      const others = Object.fromEntries(Object.entries(await read()).filter(([entry]) => entry !== origin))
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Encryption is not available, so the key was not saved')
      await writeFile(path, safeStorage.encryptString(JSON.stringify(key ? { ...others, [origin]: key } : others)), { mode: 0o600 })
    }
  }
}
