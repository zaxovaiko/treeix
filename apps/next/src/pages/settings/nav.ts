import { sectionVisible, type SettingsSection } from '../../features'
import type { Features } from '../../ipc/api'

/** A remembered section can go missing when its feature is switched off; Features is where it comes back on */
export const openableSection = (section: SettingsSection, features: Features): SettingsSection => (sectionVisible(section, features) ? section : 'features')

let requested: SettingsSection | null = null
const listeners = new Set<(section: SettingsSection) => void>()

/** Asks Settings for a section: the open page switches to it, a closed one opens on it */
export function showSettingsSection(section: SettingsSection): void {
  requested = listeners.size ? null : section
  listeners.forEach((listener) => listener(section))
}

export function takeRequestedSection(): SettingsSection | null {
  const section = requested
  requested = null
  return section
}

export function onSettingsSection(listener: (section: SettingsSection) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
