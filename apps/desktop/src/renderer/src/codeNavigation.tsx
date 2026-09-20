import { getSharedHighlighter } from '@pierre/diffs'
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { supportsLanguageService } from '../../shared/languages'
import type { HoverInfo, NavigationKind, SymbolTarget } from '../../shared/types'
import { matchesShortcut, toAccelerator } from '../../shared/shortcut'
import { copyText, openMenu } from './contextMenu'
import { activeTheme, getSettings } from './settings'
import { LazyMarkdown } from './LazyMarkdown'
import { Popup } from './ui'
import { codeTheme } from './themes'

const HOVER_DELAY_MS = 450
const HOVER_GRACE_MS = 200

/** Signatures are TypeScript, highlighted with the same theme as the diff; shiki escapes the code it renders */
async function highlightSignature(code: string): Promise<string> {
  const theme = codeTheme(activeTheme())
  const highlighter = await getSharedHighlighter({ themes: [theme], langs: ['typescript'] })
  return highlighter.codeToHtml(code, { lang: 'typescript', theme })
}

export type Navigate = (kind: NavigationKind, target: SymbolTarget, worktreePath: string) => void

/**
 * Where code outside a worktree view (PR diffs, markdown code blocks) resolves symbols.
 * `exact` is false when the checkout is not on the code's branch, so positions are unreliable and lookups fall back to text search
 */
export type CodeContext = { worktreePath: string; exact: boolean; onNavigate: Navigate }
export const CodeNavigationContext = createContext<CodeContext | null>(null)

type TokenEvent = { lineNumber: number; lineCharStart: number; tokenText: string; tokenElement: HTMLElement; side?: 'additions' | 'deletions' }

export const NAVIGATION_ACTIONS: { kind: NavigationKind; label: string; description: string }[] = [
  { kind: 'definition', label: 'Go to Definition', description: 'Jumps to where the symbol is declared; on the declaration itself it lists references.' },
  { kind: 'typeDefinition', label: 'Go to Type Definition', description: 'Jumps to the declaration of the symbol’s type (TypeScript and JavaScript).' },
  { kind: 'implementation', label: 'Go to Implementations', description: 'Classes and objects implementing an interface or abstract member.' },
  { kind: 'references', label: 'Find All References', description: 'Every usage, grouped by file with a preview. F-keys need fn unless macOS uses them as standard function keys.' }
]

const acceleratorFor = (kind: NavigationKind): string | undefined => {
  const shortcut = getSettings().navigationKeys[kind]
  return (shortcut && toAccelerator(shortcut)) ?? undefined
}

/** The symbol F12 and friends act on: the last one clicked or hovered in any code view */
let activeTarget: { target: SymbolTarget; worktreePath: string } | null = null
export const getActiveTarget = (): { target: SymbolTarget; worktreePath: string } | null => activeTarget

export function navigationKindForKey(event: KeyboardEvent): NavigationKind | null {
  const keys = getSettings().navigationKeys
  return NAVIGATION_ACTIONS.find(({ kind }) => matchesShortcut(event, keys[kind]))?.kind ?? null
}

// Keywords tokenize like identifiers but never resolve, so they don't get the link affordance
const KEYWORDS = new Set(
  'abstract as async await break case catch class const continue debugger declare default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface is keyof let namespace new null of private protected public readonly return satisfies set static super switch this throw true try type typeof undefined unique var void while with yield def fn func pub struct impl use mod self nil None True False elif lambda pass'.split(' ')
)

/**
 * Underlines the hovered symbol, solid and accent colored while ⌘ is held (⌘+click jumps).
 * Drawn as a fixed overlay: the diff renderer re-creates token spans on hover, which would drop styles set on them
 */
let underlined: HTMLElement | null = null
let underline: HTMLDivElement | null = null
let pointerHost: HTMLElement | null = null
let underlineBox: { box: DOMRect; color: string; host: Element | null } | null = null
function paintUnderline(element: HTMLElement | null, metaKey: boolean): void {
  // Toggling ⌘ repaints the same symbol even after its span was re-created
  if (element?.isConnected) {
    const root = element.getRootNode()
    underlineBox = { box: element.getBoundingClientRect(), color: getComputedStyle(element).color, host: root instanceof ShadowRoot ? root.host : null }
  } else if (element !== underlined) underlineBox = null
  underlined = element
  if (pointerHost) pointerHost.style.cursor = ''
  pointerHost = null
  if (!element || !underlineBox) {
    if (underline) underline.style.display = 'none'
    return
  }
  if (!underline) {
    underline = document.createElement('div')
    underline.style.cssText = 'position:fixed;z-index:60;pointer-events:none;height:0'
    document.body.appendChild(underline)
  }
  const { box, color, host } = underlineBox
  Object.assign(underline.style, {
    display: 'block',
    left: `${box.left}px`,
    top: `${box.bottom - 1}px`,
    width: `${box.width}px`,
    borderBottom: metaKey ? '1px solid var(--color-primary, #818cf8)' : '1px dotted color-mix(in srgb, currentColor 55%, transparent)',
    color
  })
  if (metaKey && host instanceof HTMLElement) {
    pointerHost = host
    pointerHost.style.cursor = 'pointer'
  }
}
window.addEventListener('scroll', () => paintUnderline(null, false), true)
for (const type of ['keydown', 'keyup'] as const) {
  window.addEventListener(type, (event) => event.key === 'Meta' && paintUnderline(underlined, event.metaKey))
}
window.addEventListener('blur', () => paintUnderline(underlined, false))

const textTarget = (symbol: string): SymbolTarget => ({ path: '', line: 0, column: 0, symbol })

function targetFromToken(path: string, token: TokenEvent, exact: boolean): SymbolTarget | null {
  const match = token.tokenText.match(/[A-Za-z_$][\w$]*/)
  if (!match || match.index === undefined || KEYWORDS.has(match[0])) return null
  // Removed lines no longer exist on disk, so line 0 asks for a text search instead of a position lookup
  const line = token.side === 'deletions' || !exact ? 0 : token.lineNumber
  return { path, line, column: token.lineCharStart + match.index, symbol: match[0] }
}

/** Token handlers for @pierre/diffs views plus the hover card and right-click menu they drive */
export function useSymbolNavigation({
  worktreePath,
  path,
  exact = true,
  onNavigate
}: {
  worktreePath: string
  path: string
  exact?: boolean
  onNavigate: Navigate
}): {
  tokenOptions: {
    useTokenTransformer: true
    onTokenClick: (token: TokenEvent, event: MouseEvent) => void
    onTokenEnter: (token: TokenEvent, event: PointerEvent) => void
    onTokenLeave: () => void
  }
  onContextMenu: (event: React.MouseEvent) => void
  hoverCard: React.JSX.Element | null
} {
  const hovered = useRef<SymbolTarget | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [card, setCard] = useState<{ info: HoverInfo; html: string | null; anchor: DOMRect } | null>(null)

  const hideSoon = (): void => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCard(null), HOVER_GRACE_MS)
  }

  useEffect(() => {
    const hide = (): void => setCard(null)
    window.addEventListener('wheel', hide, { passive: true })
    return () => {
      window.removeEventListener('wheel', hide)
      clearTimeout(timer.current)
    }
  }, [])

  const tokenOptions = {
    useTokenTransformer: true as const,
    onTokenClick: (token: TokenEvent, event: MouseEvent) => {
      const target = targetFromToken(path, token, exact)
      if (!target) return
      activeTarget = { target, worktreePath }
      if (event.metaKey) onNavigate('definition', target, worktreePath)
    },
    onTokenEnter: (token: TokenEvent, event: PointerEvent) => {
      // Measured now: the renderer re-creates token spans on hover, so the element may be gone when the card opens
      const { top, height } = token.tokenElement.getBoundingClientRect()
      const anchor = new DOMRect(event.clientX - 12, top, 0, height)
      const target = targetFromToken(path, token, exact)
      hovered.current = target
      paintUnderline(target ? token.tokenElement : null, event.metaKey)
      if (!target) return
      activeTarget = { target, worktreePath }
      clearTimeout(timer.current)
      if (target.line === 0 || !supportsLanguageService(path)) return
      timer.current = setTimeout(async () => {
        const info = await window.api.hover(worktreePath, target)
        const html = info && (await highlightSignature(info.signature).catch(() => null))
        if (hovered.current !== target) return
        setCard(info ? { info, html, anchor } : null)
      }, HOVER_DELAY_MS)
    },
    onTokenLeave: () => {
      hovered.current = null
      paintUnderline(null, false)
      hideSoon()
    }
  }

  const onContextMenu = (event: React.MouseEvent): void => {
    const target = hovered.current
    if (!target) return
    setCard(null)
    openMenu(event, [
      ...NAVIGATION_ACTIONS.map(({ kind, label }) => ({
        label,
        accelerator: acceleratorFor(kind),
        enabled: kind === 'definition' || kind === 'references' || supportsLanguageService(path),
        run: () => onNavigate(kind, target, worktreePath)
      })),
      null,
      { label: `Copy "${target.symbol}"`, run: () => copyText(target.symbol) }
    ])
  }

  // Portaled: dialogs use backdrop-filter, which would make this fixed card position relative to the dialog
  const hoverCard = card && (
    <Popup
      anchor={card.anchor}
      onMouseEnter={() => clearTimeout(timer.current)}
      onMouseLeave={hideSoon}
      className="max-h-80 w-max max-w-[560px] overflow-auto rounded-lg border border-input bg-popover backdrop-blur-2xl"
    >
      {card.html ? (
        <div
          className="px-3 py-2 font-mono text-[12px] [&_pre]:!bg-transparent [&_pre]:whitespace-pre-wrap"
          dangerouslySetInnerHTML={{ __html: card.html }}
        />
      ) : (
        <pre className="px-3 py-2 font-mono text-[12px] whitespace-pre-wrap text-foreground/90">{card.info.signature}</pre>
      )}
      {card.info.documentation && (
        <div className="border-t border-border px-3 py-2 text-[12.5px]">
          <LazyMarkdown>{card.info.documentation}</LazyMarkdown>
        </div>
      )}
    </Popup>
  )

  return { tokenOptions, onContextMenu, hoverCard }
}

function identifierAtPoint(x: number, y: number): string | null {
  const range = document.caretRangeFromPoint(x, y)
  const text = range?.startContainer.textContent
  if (!range || !text) return null
  const isIdentifier = (char: string | undefined): boolean => char !== undefined && /[\w$]/.test(char)
  let start = range.startOffset
  let end = range.startOffset
  while (isIdentifier(text[start - 1])) start--
  while (isIdentifier(text[end])) end++
  const word = text.slice(start, end)
  return /^[A-Za-z_$][\w$]*$/.test(word) ? word : null
}

/** Code blocks in markdown have no file position, so ⌘+click and the menu search the checkout by name */
export function NavigableCode(props: React.HTMLAttributes<HTMLElement>): React.JSX.Element {
  const context = useContext(CodeNavigationContext)
  if (!context) return <code {...props} />
  const symbolAt = (event: React.MouseEvent): SymbolTarget | null => {
    const symbol = identifierAtPoint(event.clientX, event.clientY)
    return symbol ? textTarget(symbol) : null
  }
  return (
    <code
      {...props}
      onClick={(event) => {
        const target = symbolAt(event)
        if (!target) return
        activeTarget = { target, worktreePath: context.worktreePath }
        if (event.metaKey) context.onNavigate('definition', target, context.worktreePath)
      }}
      onContextMenu={(event) => {
        const target = symbolAt(event)
        if (!target) return
        openMenu(event, [
          { label: 'Go to Definition', accelerator: acceleratorFor('definition'), run: () => context.onNavigate('definition', target, context.worktreePath) },
          { label: 'Find All References', accelerator: acceleratorFor('references'), run: () => context.onNavigate('references', target, context.worktreePath) },
          null,
          { label: `Copy "${target.symbol}"`, run: () => copyText(target.symbol) }
        ])
      }}
    />
  )
}
