import { totalmem } from 'node:os'
import type { MainContext } from '@treeix/sdk/main'
import { isJson, isString, list, object, parseJson } from '@treeix/shared/json'
import { type LocalModelsState, longContextId } from '../shared/catalog'
import { API_PRESETS } from '../shared/types'

const LONG_CONTEXT_TOKENS = 65_536
const OLLAMA = API_PRESETS.find((preset) => preset.name === 'Ollama')?.baseUrl.replace(/\/v1$/, '') ?? 'http://localhost:11434'

async function ollama(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${OLLAMA}${path}`, init)
  if (!response.ok) throw new Error((await response.text()) || `Ollama answered ${response.status}`)
  return response
}

const post = (path: string, body: Record<string, unknown>, init: RequestInit = {}): Promise<Response> =>
  ollama(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...init })

/** Downloads, deletes and lists models through Ollama's own API for the Local models settings */
export function ollamaHandlers(context: MainContext): void {
  const pulls = new Map<string, AbortController>()

  context.handle('localModels', async (): Promise<LocalModelsState> => {
    try {
      const models = list(object(await (await ollama('/api/tags')).json()).models)
      return { installed: models.flatMap((model) => (isString(model.name) ? [model.name] : [])), totalGB: totalmem() / 2 ** 30 }
    } catch {
      return null
    }
  })

  // Progress streams as JSON lines; each layer reports its own total, so the fraction restarts per layer
  const pull = async (id: string, signal: AbortSignal): Promise<void> => {
    const response = await post('/api/pull', { model: id }, { signal })
    if (!response.body) throw new Error('Ollama sent nothing')
    let rest = ''
    let percent = -1
    for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
      const lines = (rest + chunk).split('\n')
      rest = lines.pop() ?? ''
      for (const line of lines) {
        const update = parseJson(line)
        if (!isJson(update)) continue
        if (isString(update.error)) throw new Error(update.error)
        const { completed, total } = update
        if (typeof completed !== 'number' || typeof total !== 'number' || !total) continue
        const next = Math.floor((completed / total) * 100)
        if (next !== percent) context.broadcast('pull', id, (percent = next))
      }
    }
  }
  // A cancelled download ends quietly; Ollama keeps the layers it got, so a later Download resumes
  context.handle('pullModel', async (_, id: string) => {
    const abort = new AbortController()
    pulls.set(id, abort)
    try {
      await pull(id, abort.signal)
    } catch (error) {
      if (!abort.signal.aborted) throw error
    } finally {
      pulls.delete(id)
    }
  })
  context.handle('cancelPull', (_, id: string) => pulls.get(id)?.abort())

  context.handle('deleteModel', async (_, id: string) => void (await post('/api/delete', { model: id }, { method: 'DELETE' })))
  context.handle(
    'longContext',
    async (_, id: string) => void (await post('/api/create', { model: longContextId(id), from: id, parameters: { num_ctx: LONG_CONTEXT_TOKENS }, stream: false }))
  )
}
