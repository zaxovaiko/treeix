import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { shell, systemPreferences } from 'electron'
import { type NativeHelper, nativeBinary, nativeHelpersSupported, speechModelsPath, superviseHelper } from '@treeix/host/nativeHelper'
import { readJsonFile } from '@treeix/host/paths'
import { isJson, isString, list, object } from '@treeix/shared/json'
import type { MainPlugin } from '@treeix/sdk/main'
import { type DictationSettings, type Dictation, type Permissions, type Status, parseSettings } from '../shared/types'
import { type HelperCommand, type HelperMessage, parseHelperMessage } from './protocol'
import { applyVocabulary, format, formatterModels } from './text'

const HISTORY_LIMIT = 50

const isDictation = (value: unknown): value is Dictation =>
  isJson(value) && typeof value.at === 'number' && isString(value.raw) && isString(value.text) && (value.app === null || isString(value.app))

const permissions = (): Permissions => ({
  microphone: systemPreferences.getMediaAccessStatus('microphone'),
  accessibility: systemPreferences.isTrustedAccessibilityClient(false)
})

const openPrivacyPane = (pane: 'Microphone' | 'Accessibility'): Promise<void> => shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?Privacy_${pane}`)

/** Models used to live in the plugin's own folder; they move to the shared one once, and copies it already has go */
function adoptModels(legacy: string): void {
  if (!existsSync(legacy)) return
  const shared = speechModelsPath()
  mkdirSync(shared, { recursive: true })
  for (const name of readdirSync(legacy)) if (!existsSync(join(shared, name))) renameSync(join(legacy, name), join(shared, name))
  rmSync(legacy, { recursive: true, force: true })
}

const plugin: MainPlugin = {
  activate: (context) => {
    const historyPath = join(context.dataPath, 'history.json')
    let status: Status = { helper: nativeHelpersSupported ? 'starting' : 'unsupported', models: [], error: null }
    let settings: DictationSettings | null = null
    let helper: NativeHelper | null = null
    let history: Promise<Dictation[]> = readJsonFile(historyPath).then((value) => list(value, isDictation))

    const setStatus = (patch: Partial<Status>): void => {
      status = { ...status, ...patch }
      context.broadcast('status', status)
    }

    const command = (message: HelperCommand): void => {
      helper?.send(message)
    }

    const configure = (): void => {
      if (!settings) return
      const { hotkey, tapToToggle, sounds, model, formatting } = settings
      command({ type: 'configure', hotkey, tapToToggle, sounds, model, formatting: formatting.enabled && formatting.model !== '', modelsPath: speechModelsPath() })
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

    const transcribed = async ({ id, text: raw, app: appName, continues }: Extract<HelperMessage, { type: 'transcript' }>): Promise<void> => {
      const current = settings ?? parseSettings({})
      let result = applyVocabulary(raw, current.vocabulary)
      if (current.formatting.enabled && current.formatting.model) {
        const formatted = await format(result, current.formatting, current.vocabulary)
        if (formatted.error) setStatus({ error: `Formatting skipped: ${formatted.error}` })
        result = formatted.text
      }
      command({ type: 'insert', id, text: result })
      // Pieces of one dictation are one history entry
      await updateHistory((items) =>
        continues && items[0]
          ? [{ ...items[0], raw: `${items[0].raw} ${raw}`, text: `${items[0].text} ${result}` }, ...items.slice(1)]
          : [{ at: Date.now(), raw, text: result, app: appName }, ...items].slice(0, HISTORY_LIMIT)
      )
    }
    // Formatting takes a different time per piece, so pieces wait their turn to be typed in the order they were said
    let typing = Promise.resolve()

    const receive = (message: HelperMessage): void => {
      switch (message.type) {
        case 'ready':
          setStatus({ helper: 'running' })
          return configure()
        case 'models':
          return setStatus({ models: message.models })
        case 'transcript':
          typing = typing.then(() => transcribed(message)).catch((error: unknown) => setStatus({ error: `Couldn't type it: ${String(error)}` }))
          return
        case 'error':
          return setStatus({ error: message.message })
      }
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

    if (nativeHelpersSupported) {
      adoptModels(join(context.dataPath, 'models'))
      helper = superviseHelper(nativeBinary('treeix-voice'), 'dictation', {
        line: (line) => {
          const message = parseHelperMessage(line)
          if (message) receive(message)
        },
        down: (reason) => setStatus({ helper: 'crashed', models: [], error: reason })
      })
      if (!helper) setStatus({ helper: 'missing' })
    }
    context.onDispose(() => helper?.stop())
  }
}

export default plugin
