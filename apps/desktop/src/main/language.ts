import { utilityProcess, type UtilityProcess } from 'electron'
import { supportsLanguageService } from '../shared/languages'
import type { CodeLocation, HoverInfo, LanguageRequest, NavigationKind, SymbolTarget } from '../shared/types'
import { findDefinitions, findTextReferences } from './git'
import languageProcessPath from './languageProcess?modulePath'

const REQUEST_TIMEOUT_MS = 60_000

type Pending = { resolve: (result: unknown) => void; reject: (error: Error) => void }
let child: UtilityProcess | null = null
let nextId = 0
const pending = new Map<number, Pending>()

function languageProcess(): UtilityProcess {
  if (child) return child
  const started = utilityProcess.fork(languageProcessPath, [], { serviceName: 'Treeix language service' })
  started.on('message', (message: { id: number; result?: unknown; error?: string }) => {
    const request = pending.get(message.id)
    pending.delete(message.id)
    if (message.error !== undefined) request?.reject(new Error(message.error))
    else request?.resolve(message.result ?? null)
  })
  started.on('exit', () => {
    child = null
    for (const request of pending.values()) request.reject(new Error('Language service stopped'))
    pending.clear()
  })
  child = started
  return started
}

function ask<T>(request: LanguageRequest): Promise<T | null> {
  const id = nextId++
  return new Promise<T | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('Language service timed out'))
    }, REQUEST_TIMEOUT_MS)
    const settle = <V>(done: (value: V) => void) => (value: V) => {
      clearTimeout(timer)
      done(value)
    }
    pending.set(id, { resolve: settle((value) => resolve(value as T | null)), reject: settle(reject) })
    languageProcess().postMessage({ id, request })
  })
}

export async function navigate(worktreePath: string, kind: NavigationKind, target: SymbolTarget): Promise<CodeLocation[]> {
  if (supportsLanguageService(target.path)) {
    const locations = await ask<CodeLocation[]>({ type: 'navigate', worktreePath, kind, target }).catch(() => null)
    if (locations?.length) return locations
  }
  if (kind === 'definition') return findDefinitions(worktreePath, target.symbol)
  if (kind === 'references') return findTextReferences(worktreePath, target.symbol)
  return []
}

export const hover = (worktreePath: string, target: SymbolTarget): Promise<HoverInfo | null> =>
  supportsLanguageService(target.path) ? ask<HoverInfo>({ type: 'hover', worktreePath, target }).catch(() => null) : Promise.resolve(null)

export function stopLanguageProcess(): void {
  child?.kill()
}
