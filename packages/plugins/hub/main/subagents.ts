import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { agentDirectories, mainCheckoutOf } from '@treeix/host/projects'
import { parseSubagent, subagentBody, type Subagent } from '../shared/subagents'

// Rendered Claude files first; rulesync and Codex are the same agents, read only where nothing rendered them
const SOURCES = [
  { dir: join('.claude', 'agents'), ext: '.md' },
  { dir: join('.rulesync', 'subagents'), ext: '.md' },
  { dir: join('.codex', 'agents'), ext: '.toml' }
]

const read = async (folder: string, dir: string, ext: string): Promise<Subagent[]> => {
  const path = join(folder, dir)
  const files = await readdir(path).catch((): string[] => [])
  const texts = await Promise.all(
    files
      .filter((file) => file.endsWith(ext))
      .map((file) =>
        readFile(join(path, file), 'utf8').then(
          (text) => [join(path, file), text] as const,
          () => null
        )
      )
  )
  return texts.flatMap((entry) => {
    const subagent = entry && parseSubagent(folder, entry[0], entry[1])
    return subagent ? [subagent] : []
  })
}

/** The system prompt and model of one subagent, for a step that runs as it; null when the file is gone */
export async function readSubagent(path: string): Promise<{ instructions: string; model: string | null } | null> {
  const text = await readFile(path, 'utf8').catch(() => null)
  if (text === null) return null
  return { instructions: subagentBody(path, text), model: parseSubagent('', path, text)?.model ?? null }
}

/**
 * What a step's `subagent` runs as, from `cwd`: a path is that file; a name is the one `cwd` defines. Repos under `cwd` that
 * define it are listed, and the agent follows its own repo's once it knows which. null when none does
 */
export async function resolveSubagent(subagent: string, cwd: string): Promise<{ instructions: string; model: string | null } | null> {
  if (subagent.includes('/')) return readSubagent(subagent)
  // A ticket's worktree lacks the subagents its repo generates and ignores, so its main checkout's stand in
  const main = await mainCheckoutOf(cwd)
  return (await resolveIn(subagent, cwd)) ?? (main ? resolveIn(subagent, main) : null)
}

async function resolveIn(subagent: string, cwd: string): Promise<{ instructions: string; model: string | null } | null> {
  const found = (await readSubagents([cwd])).filter((candidate) => candidate.name === subagent)
  const own = found.find((candidate) => candidate.folder === cwd)
  if (own) return readSubagent(own.path)
  if (!found.length) return null
  const models = new Set(found.map((candidate) => candidate.model))
  return {
    instructions: [
      `You work as the ${subagent} subagent of the repo this task belongs to. Once you know the repo, read its file below and follow it as your instructions; a repo not listed has none, so work as yourself there.`,
      ...found.map((candidate) => `- ${candidate.path}`)
    ].join('\n'),
    model: models.size === 1 ? found[0].model : null
  }
}

/** The subagents these folders, the repos right under them and the folders their Claude settings add define (home's are the user's own), each folder read from the first source that has any */
export async function readSubagents(folders: string[]): Promise<Subagent[]> {
  const nested = await Promise.all(folders.map((folder) => (folder === homedir() ? [] : agentDirectories(folder))))
  const found = await Promise.all(
    [...new Set([...folders, ...nested.flat()])].map(async (folder) => {
      for (const { dir, ext } of SOURCES) {
        const subagents = await read(folder, dir, ext)
        if (subagents.length) return subagents
      }
      return []
    })
  )
  return found.flat().sort((a, b) => a.name.localeCompare(b.name))
}
