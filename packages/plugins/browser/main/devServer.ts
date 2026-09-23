import { access, readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'

const SCRIPTS = ['dev', 'start', 'serve']
const LOCKFILES: [string, string][] = [
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn']
]

/** `pnpm run dev` for the first dev-like script in package.json, with the package manager its lockfile names */
export function devCommand(packageJson: unknown, lockfiles: string[]): string | null {
  const scripts = typeof packageJson === 'object' && packageJson !== null && 'scripts' in packageJson ? packageJson.scripts : null
  const script = SCRIPTS.find((name) => typeof scripts === 'object' && scripts !== null && name in scripts)
  if (!script) return null
  const manager = LOCKFILES.find(([file]) => lockfiles.includes(file))?.[1] ?? 'npm'
  return `${manager} run ${script}`
}

/** A port nothing listens on right now; the OS picks it */
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('No free port'))))
    })
  })

/** The command that starts the folder's dev server on a free port; PORT is honored by Next, Nuxt, Remix, Astro and most Node servers */
export async function devServerCommand(folder: string): Promise<string | null> {
  const text = await readFile(join(folder, 'package.json'), 'utf8').catch(() => null)
  if (text === null) return null
  let packageJson: unknown = null
  try {
    packageJson = JSON.parse(text)
  } catch {
    return null
  }
  const present = await Promise.all(LOCKFILES.map(([file]) => access(join(folder, file)).then(() => file, () => null)))
  const command = devCommand(packageJson, present.filter((file) => file !== null))
  return command && `PORT=${await freePort()} ${command}`
}
