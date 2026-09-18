import { open, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { Plan } from '../shared/types'

// Claude Code's default plansDirectory
const PLANS_DIR = join(homedir(), '.claude', 'plans')

export const planTitle = (markdown: string, fallback: string): string => markdown.match(/^#\s+(.+)$/m)?.[1].trim() ?? fallback

const TITLE_BYTES = 4096
const titles = new Map<string, { modifiedAt: number; title: string }>()

/** Titles sit at the top, so read only the head and reuse it until the file changes */
async function titleOf(path: string, modifiedAt: number, fallback: string): Promise<string> {
  const cached = titles.get(path)
  if (cached?.modifiedAt === modifiedAt) return cached.title
  const file = await open(path)
  try {
    const { buffer, bytesRead } = await file.read(Buffer.alloc(TITLE_BYTES), 0, TITLE_BYTES, 0)
    const title = planTitle(buffer.subarray(0, bytesRead).toString('utf8'), fallback)
    titles.set(path, { modifiedAt, title })
    return title
  } finally {
    await file.close()
  }
}

export async function listPlans(): Promise<Plan[]> {
  const names = (await readdir(PLANS_DIR).catch(() => [])).filter((name) => name.endsWith('.md'))
  const plans = await Promise.all(
    names.map(async (name) => {
      const path = join(PLANS_DIR, name)
      const modifiedAt = (await stat(path)).mtimeMs
      return { name, path, title: await titleOf(path, modifiedAt, name.replace(/\.md$/, '')), modifiedAt }
    })
  )
  return plans.sort((a, b) => b.modifiedAt - a.modifiedAt)
}

export async function readPlan(name: string): Promise<string | null> {
  if (basename(name) !== name || !name.endsWith('.md')) return null
  return readFile(join(PLANS_DIR, name), 'utf8').catch(() => null)
}
