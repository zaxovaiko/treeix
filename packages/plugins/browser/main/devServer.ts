import { access } from 'node:fs/promises'
import { readJsonFile } from '@treeix/host/paths'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { object } from '@treeix/shared/json'

const SCRIPTS = ['dev', 'start', 'serve']
const LOCKFILES: [string, string][] = [
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn']
]

/** `pnpm run dev` for the first dev-like script in package.json, with the package manager its lockfile names */
export function devCommand(packageJson: unknown, lockfiles: string[]): string | null {
  const scripts = object(object(packageJson).scripts)
  const script = SCRIPTS.find((name) => name in scripts)
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
  const packageJson = await readJsonFile(join(folder, 'package.json'))
  if (packageJson === null) return null
  const present = await Promise.all(
    LOCKFILES.map(([file]) =>
      access(join(folder, file)).then(
        () => file,
        () => null
      )
    )
  )
  const command = devCommand(
    packageJson,
    present.filter((file) => file !== null)
  )
  return command && `PORT=${await freePort()} ${command}`
}
