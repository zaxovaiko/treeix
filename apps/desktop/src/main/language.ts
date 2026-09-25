import { utilityProcess, type UtilityProcess } from 'electron'
import { supportsLanguageService } from '../shared/languages'
import type { CodeDiagnostic, CodeLocation, CodePosition, CompletionDetails, CompletionItem, HoverInfo, LanguageRequest, NavigationKind, SignatureHelp, SymbolTarget } from '../shared/types'
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

const forTypeScript = <T>(path: string, request: LanguageRequest, fallback: T): Promise<T> =>
  supportsLanguageService(path) ? ask<T>(request).then((result) => result ?? fallback, () => fallback) : Promise.resolve(fallback)

export const completions = (worktreePath: string, path: string, text: string, position: CodePosition): Promise<CompletionItem[]> =>
  forTypeScript(path, { type: 'completions', worktreePath, path, text, position }, [])
export const completionDetails = (worktreePath: string, path: string, text: string, position: CodePosition, name: string, source: string | null, data: string | null): Promise<CompletionDetails | null> =>
  forTypeScript(path, { type: 'completionDetails', worktreePath, path, text, position, name, source, data }, null)
export const signatureHelp = (worktreePath: string, path: string, text: string, position: CodePosition): Promise<SignatureHelp | null> =>
  forTypeScript(path, { type: 'signatureHelp', worktreePath, path, text, position }, null)
export const diagnostics = (worktreePath: string, path: string, text: string): Promise<CodeDiagnostic[]> =>
  forTypeScript(path, { type: 'diagnostics', worktreePath, path, text }, [])
/** Only a running process holds overlays, so there is nothing to close otherwise */
export function closeDocument(worktreePath: string, path: string): void {
  if (child && supportsLanguageService(path)) void ask({ type: 'closeDocument', worktreePath, path }).catch(() => null)
}

export function stopLanguageProcess(): void {
  child?.kill()
}
