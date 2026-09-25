import { closeDocument, completionDetails, completions, diagnostics, hover, navigate, signatureHelp } from './languageService'
import type { LanguageRequest } from '../shared/types'

function answer(request: LanguageRequest): unknown {
  switch (request.type) {
    case 'hover':
      return hover(request.worktreePath, request.target)
    case 'navigate':
      return navigate(request.worktreePath, request.kind, request.target)
    case 'completions':
      return completions(request.worktreePath, request.path, request.text, request.position)
    case 'completionDetails':
      return completionDetails(request.worktreePath, request.path, request.text, request.position, request.name, request.source, request.data)
    case 'signatureHelp':
      return signatureHelp(request.worktreePath, request.path, request.text, request.position)
    case 'diagnostics':
      return diagnostics(request.worktreePath, request.path, request.text)
    case 'closeDocument':
      return closeDocument(request.worktreePath, request.path)
  }
}

// Runs in an Electron utility process so building programs for big repos never blocks the main process
process.parentPort.on('message', ({ data }: { data: { id: number; request: LanguageRequest } }) => {
  const { id, request } = data
  try {
    process.parentPort.postMessage({ id, result: answer(request) })
  } catch (error: unknown) {
    process.parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
  }
})
