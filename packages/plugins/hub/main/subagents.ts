import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
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

/** The subagents these folders define, each folder read from the first source that has any */
export async function readSubagents(folders: string[]): Promise<Subagent[]> {
  const found = await Promise.all(
    folders.map(async (folder) => {
      for (const { dir, ext } of SOURCES) {
        const subagents = await read(folder, dir, ext)
        if (subagents.length) return subagents
      }
      return []
    })
  )
  return found.flat().sort((a, b) => a.name.localeCompare(b.name))
}
