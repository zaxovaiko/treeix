import { app, Menu, nativeImage, Tray } from 'electron'
import type { MenuBarStatus } from '@treeix/sdk/main'
import glyphPath from '../../resources/menuBarGlyph.png?asset'
import { HEIGHT, menuBarAlpha } from './menuBarImage'

let tray: Tray | null = null
let open: (() => void) | null = null
/** Each plugin's own part; the item shows them side by side */
const statuses = new Map<string, MenuBarStatus>()
let status: MenuBarStatus = { title: '', meters: [], lines: [] }

function glyphAlpha(): { width: number; alpha: Uint8Array } {
  const image = nativeImage.createFromPath(glyphPath).resize({ height: HEIGHT })
  const bgra = image.toBitmap()
  return { width: bgra.length / 4 / HEIGHT, alpha: Uint8Array.from({ length: bgra.length / 4 }, (_, pixel) => bgra[pixel * 4 + 3]) }
}

function render(): void {
  if (!tray || !open) return
  const { width, alpha } = menuBarAlpha(glyphAlpha(), status.meters)
  // Black with the drawn alpha; as a template image macOS tints it for light and dark menu bars
  const bgra = Buffer.alloc(alpha.length * 4)
  alpha.forEach((value, pixel) => (bgra[pixel * 4 + 3] = value))
  const image = nativeImage.createFromBitmap(bgra, { width, height: HEIGHT, scaleFactor: 2 })
  image.setTemplateImage(true)
  tray.setImage(image)
  tray.setTitle(status.title, { fontType: 'monospacedDigit' })
  tray.setToolTip(status.lines.join('\n') || 'Treeix')
  const show = open
  tray.setContextMenu(
    Menu.buildFromTemplate([
      ...status.lines.map((label) => ({ label, enabled: false })),
      ...(status.lines.length ? [{ type: 'separator' as const }] : []),
      { label: 'Open Treeix', click: show },
      { label: 'Quit Treeix', click: () => app.quit() }
    ])
  )
}

/** Treeix in the macOS menu bar while the hotkey window is on, where `onOpen` brings it up; null takes it away */
export function showMenuBar(onOpen: (() => void) | null): void {
  open = onOpen
  if (!onOpen) {
    tray?.destroy()
    tray = null
    return
  }
  tray ??= new Tray(nativeImage.createEmpty())
  render()
}

/** What a plugin shows in the menu bar item, beside the other plugins' parts; null takes its part away */
export function setMenuBarStatus(pluginId: string, next: MenuBarStatus | null): void {
  if (next) statuses.set(pluginId, next)
  else statuses.delete(pluginId)
  const parts = [...statuses.values()]
  status = {
    title: parts
      .map((part) => part.title)
      .filter(Boolean)
      .join('  '),
    meters: parts.flatMap((part) => part.meters),
    lines: parts.flatMap((part) => part.lines)
  }
  render()
}
