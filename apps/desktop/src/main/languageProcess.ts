import { hover, navigate } from './languageService'
import type { LanguageRequest } from '../shared/types'

// Runs in an Electron utility process so building programs for big repos never blocks the main process
process.parentPort.on('message', ({ data }: { data: { id: number; request: LanguageRequest } }) => {
  const { id, request } = data
  try {
    const result =
      request.type === 'hover' ? hover(request.worktreePath, request.target) : navigate(request.worktreePath, request.kind, request.target)
    process.parentPort.postMessage({ id, result })
  } catch (error: unknown) {
    process.parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
  }
})
