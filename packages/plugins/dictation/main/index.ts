import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { release } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { app, shell, systemPreferences } from 'electron'
import { readJsonFile } from '@treeix/host/paths'
import { isJson, isString, list, object } from '@treeix/shared/json'
import type { MainPlugin } from '@treeix/sdk/main'
import { type DictationSettings, type Dictation, type Permissions, type Status, parseSettings } from '../shared/types'
import { type HelperCommand, type HelperMessage, parseHelperMessage } from './protocol'
import { applyVocabulary, format, formatterModels } from './text'

const HISTORY_LIMIT = 50
/** A helper that ran this long before dying starts again right away; quicker deaths back off up to MAX_BACKOFF_MS */
const HEALTHY_MS = 60_000
const MAX_BACKOFF_MS = 30_000

/** FluidAudio runs speech models on the Neural Engine and needs macOS 14 (Darwin 23) */
const supported = process.platform === 'darwin' && process.arch === 'arm64' && Number(release().split('.')[0]) >= 23

const isDictation = (value: unknown): value is Dictation =>
  isJson(value) && typeof value.at === 'number' && isString(value.raw) && isString(value.text) && (value.app === null || isString(value.app))

const permissions = (): Permissions => ({
  microphone: systemPreferences.getMediaAccessStatus('microphone'),
  accessibility: systemPreferences.isTrustedAccessibilityClient(false)
})

const openPrivacyPane = (pane: 'Microphone' | 'Accessibility'): Promise<void> => shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?Privacy_${pane}`)

const plugin: MainPlugin = {
  activate: (context) => {
    const binary = join(app.getAppPath(), 'native', 'voice', 'bin', 'treeix-voice').replace('app.asar', 'app.asar.unpacked')
    const historyPath = join(context.dataPath, 'history.json')
    let status: Status = { helper: supported ? 'starting' : 'unsupported', models: [], error: null }
    let settings: DictationSettings | null = null
    let helper: ChildProcessWithoutNullStreams | null = null
    let restartTimer: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    let disposed = false
    let history: Promise<Dictation[]> = readJsonFile(historyPath).then((value) => list(value, isDictation))

    const setStatus = (patch: Partial<Status>): void => {
      status = { ...status, ...patch }
      context.broadcast('status', status)
    }

    const command = (message: HelperCommand): void => {
      helper?.stdin.write(`${JSON.stringify(message)}\n`)
    }

    const configure = (): void => {
      if (!settings) return
      const { hotkey, tapToToggle, sounds, model, formatting } = settings
      command({ type: 'configure', hotkey, tapToToggle, sounds, model, formatting: formatting.enabled && formatting.model !== '', modelsPath: join(context.dataPath, 'models') })
    }

    let saving = Promise.resolve()
    /** Updates go one after another, so two quick dictations never overwrite each other */
    const updateHistory = (update: (items: Dictation[]) => Dictation[]): Promise<void> => {
      history = history.then(update)
      const next = history
      saving = saving
        .then(async () => {
          const items = await next
          context.broadcast('history', items)
          await mkdir(context.dataPath, { recursive: true })
          await writeFile(historyPath, JSON.stringify(items))
        })
        .catch((error: unknown) => setStatus({ error: `Couldn't save history: ${String(error)}` }))
      return saving
    }

    const transcribed = async (id: number, raw: string, appName: string | null): Promise<void> => {
      const current = settings ?? parseSettings({})
      let result = applyVocabulary(raw, current.vocabulary)
      if (current.formatting.enabled && current.formatting.model) {
        const formatted = await format(result, current.formatting, current.vocabulary)
        if (formatted.error) setStatus({ error: `Formatting skipped: ${formatted.error}` })
        result = formatted.text
      }
      command({ type: 'insert', id, text: result })
      await updateHistory((items) => [{ at: Date.now(), raw, text: result, app: appName }, ...items].slice(0, HISTORY_LIMIT))
    }

    const receive = (message: HelperMessage): void => {
      switch (message.type) {
        case 'ready':
          setStatus({ helper: 'running' })
          return configure()
        case 'models':
          return setStatus({ models: message.models })
        case 'transcript':
          return void transcribed(message.id, message.text, message.app)
        case 'error':
          return setStatus({ error: message.message })
      }
    }

    const start = (): void => {
      if (!existsSync(binary)) return setStatus({ helper: 'missing' })
      const startedAt = Date.now()
      const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] })
      helper = child
      // Writing to a helper that just died fails asynchronously; the exit handler restarts it
      child.stdin.on('error', () => undefined)
      child.stderr.resume()
      createInterface({ input: child.stdout }).on('line', (line) => {
        const message = parseHelperMessage(line)
        if (message) receive(message)
      })
      let ended = false
      const stopped = (reason: string): void => {
        if (ended) return
        ended = true
        helper = null
        if (disposed) return
        failures = Date.now() - startedAt > HEALTHY_MS ? 0 : failures + 1
        setStatus({ helper: 'crashed', models: [], error: reason })
        restartTimer = setTimeout(start, Math.min(MAX_BACKOFF_MS, 500 * 2 ** failures))
      }
      child.on('error', (error) => stopped(`The dictation helper couldn't start: ${error.message}`))
      child.on('exit', (code, signal) => stopped(`The dictation helper stopped (${signal ?? `exit ${code}`}), restarting`))
    }

    context.handle('configure', (_, stored: unknown) => {
      settings = parseSettings(object(stored))
      configure()
    })
    context.handle('download', (_, model: unknown) => isString(model) && command({ type: 'download', model }))
    context.handle('delete', (_, model: unknown) => isString(model) && command({ type: 'delete', model }))
    context.handle('status', () => status)
    context.handle('permissions', permissions)
    context.handle('requestMicrophone', async () => {
      if (systemPreferences.getMediaAccessStatus('microphone') === 'not-determined') await systemPreferences.askForMediaAccess('microphone')
      else await openPrivacyPane('Microphone')
      return permissions()
    })
    context.handle('requestAccessibility', async () => {
      // Prompting adds Treeix to the list in System Settings, where the switch still has to be turned on
      systemPreferences.isTrustedAccessibilityClient(true)
      await openPrivacyPane('Accessibility')
      return permissions()
    })
    context.handle('history', () => history)
    context.handle('clearHistory', () => updateHistory(() => []))
    context.handle('formatterModels', (_, baseUrl: unknown) => (isString(baseUrl) ? formatterModels(baseUrl) : []))

    context.onDispose(() => {
      disposed = true
      clearTimeout(restartTimer)
      helper?.kill()
    })

    if (supported) start()
  }
}

export default plugin
