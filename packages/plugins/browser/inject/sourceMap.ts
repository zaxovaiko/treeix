import type { StackFrame } from './react'

type Section = { offset: { line: number; column: number }; map: SourceMap }
type SourceMap = { sources?: string[]; sourceRoot?: string; mappings?: string; sections?: Section[] }

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Base64 VLQ values of one mapping segment */
function decodeSegment(segment: string): number[] {
  const values: number[] = []
  let value = 0
  let shift = 0
  for (const char of segment) {
    const digit = BASE64.indexOf(char)
    value += (digit & 31) << shift
    if (digit & 32) shift += 5
    else {
      values.push(value & 1 ? -(value >> 1) : value >> 1)
      value = 0
      shift = 0
    }
  }
  return values
}

/** Where 0-based `line` and `column` of the generated code come from; index maps (Turbopack's) delegate to their section */
export function originalPlace(map: SourceMap, line: number, column: number): { sourceIndex: number; line: number; map: SourceMap } | null {
  if (map.sections) {
    const section = map.sections.filter(({ offset }) => offset.line < line || (offset.line === line && offset.column <= column)).at(-1)
    return section ? originalPlace(section.map, line - section.offset.line, line === section.offset.line ? column - section.offset.column : column) : null
  }
  const lines = (map.mappings ?? '').split(';')
  let sourceIndex = 0
  let sourceLine = 0
  let found: { sourceIndex: number; line: number } | null = null
  for (let row = 0; row <= line && row < lines.length; row++) {
    let generatedColumn = 0
    for (const segment of lines[row].split(',').filter(Boolean)) {
      const [columnDelta, sourceDelta, lineDelta] = decodeSegment(segment)
      generatedColumn += columnDelta
      if (sourceDelta === undefined) continue
      sourceIndex += sourceDelta
      sourceLine += lineDelta
      // The last segment starting at or before the column holds it
      if (row === line && generatedColumn <= column) found = { sourceIndex, line: sourceLine }
    }
  }
  return found && { ...found, map }
}

/** A bundler's source name as a project path: `turbopack:///[project]/src/a.tsx`, `webpack://_N_E/./src/a.tsx`, `../src/a.tsx` */
export function projectPath(source: string, mapUrl: string): string {
  const path = /^[a-z-]+:/.test(source) ? source.replace(/^[a-z-]+:\/*/, '') : decodeURIComponent(new URL(source, mapUrl).pathname)
  return path.replace(/^\/+/, '').replace(/^(\[project\]|_N_E|\([^)]*\))\//, '').replace(/^\.\//, '')
}

async function mapOf(scriptUrl: string): Promise<{ map: SourceMap; url: string } | null> {
  const script = await fetch(scriptUrl).then((response) => response.text())
  const reference = /\/\/[#@] sourceMappingURL=(\S+)\s*$/.exec(script.trimEnd())?.[1]
  if (!reference) return null
  const url = new URL(reference, scriptUrl).href
  const map: unknown = url.startsWith('data:') ? JSON.parse(atob(url.slice(url.indexOf(',') + 1))) : await fetch(url).then((response) => response.json())
  return typeof map === 'object' && map !== null ? { map: map as SourceMap, url } : null
}

/** The file and line a stack frame of bundled code was written at, e.g. `src/components/Avatar.tsx:42`; null without a source map */
export async function sourceOf(frame: StackFrame): Promise<string | null> {
  const found = await mapOf(frame.url).catch(() => null)
  if (!found) return null
  const place = originalPlace(found.map, frame.line - 1, frame.column - 1)
  const source = place?.map.sources?.[place.sourceIndex]
  if (!place || !source) return null
  const root = place.map.sourceRoot ? `${place.map.sourceRoot.replace(/\/?$/, '/')}` : ''
  return `${projectPath(`${root}${source}`, found.url)}:${place.line + 1}`
}
