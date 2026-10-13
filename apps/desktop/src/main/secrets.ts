import { safeStorage } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { parseJson, stringValues } from '../shared/json'

export type Secrets = { get: (name: string) => Promise<string | null>; set: (name: string, value: string | null) => Promise<void> }

/** Named secrets in one file, encrypted with the OS keychain key; the renderer only ever learns whether one is set */
export function createSecrets(path: string): Secrets {
  // ponytail: Linux without a keyring (no GNOME Keyring or KWallet) gets Chromium's fixed key, so the 0600 file mode is the real guard there
  safeStorage.setUsePlainTextEncryption(true)
  const read = async (): Promise<Record<string, string>> => {
    try {
      return stringValues(parseJson(safeStorage.decryptString(await readFile(path))))
    } catch {
      return {}
    }
  }
  return {
    get: async (name) => (await read())[name] ?? null,
    set: async (name, value) => {
      const others = Object.fromEntries(Object.entries(await read()).filter(([entry]) => entry !== name))
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Encryption is not available, so the secret was not saved')
      await writeFile(path, safeStorage.encryptString(JSON.stringify(value ? { ...others, [name]: value } : others)), { mode: 0o600 })
    }
  }
}
