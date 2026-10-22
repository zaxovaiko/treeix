import type { VocabularyTerm } from '../../ipc/api'

const KEY_LABELS: Record<string, string> = {
  MetaLeft: 'Left ⌘',
  MetaRight: 'Right ⌘',
  AltLeft: 'Left ⌥',
  AltRight: 'Right ⌥',
  ControlLeft: 'Left ⌃',
  ControlRight: 'Right ⌃',
  ShiftLeft: 'Left ⇧',
  ShiftRight: 'Right ⇧',
  Fn: 'Fn',
}

/** `Left ⌘ Right ⌥` for the saved `KeyboardEvent.code`s */
export const hotkeyLabel = (keys: string[]): string => keys.map((key) => KEY_LABELS[key] ?? key).join(' ')

/** `m:ss`, or `h:mm:ss` from an hour */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const mm = String(Math.floor(s / 60) % 60).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm}:${ss}` : `${Math.floor(s / 60)}:${ss}`
}

/** One `Term: alias, alias` line per term */
export const formatVocabulary = (terms: VocabularyTerm[]): string =>
  terms.map((t) => (t.aliases.length ? `${t.text}: ${t.aliases.join(', ')}` : t.text)).join('\n')

export function parseVocabulary(text: string): VocabularyTerm[] {
  return text
    .split('\n')
    .map((line) => {
      const [term = '', aliases = ''] = line.split(/:(.*)/s)
      return { text: term.trim(), aliases: aliases.split(',').map((a) => a.trim()).filter(Boolean) }
    })
    .filter((t) => t.text)
}
