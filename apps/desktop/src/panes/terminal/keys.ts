/** What a key chord in the terminal does instead of xterm's default handling */
export type KeyAction =
  /** xterm handles it */
  | { type: 'xterm' }
  /** Not terminal input: xterm skips it and the event bubbles to the app shell's window listeners */
  | { type: 'app' }
  | { type: 'send'; data: string }
  | { type: 'copy' }
  | { type: 'paste' }
  | { type: 'clear' }
  | { type: 'find' }

export type KeyChord = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'altKey' | 'ctrlKey' | 'shiftKey'> & Partial<Pick<KeyboardEvent, 'isComposing' | 'keyCode'>>

const XTERM: KeyAction = { type: 'xterm' }
const APP: KeyAction = { type: 'app' }

/** Readline codes macOS terminals send for Cmd+Left, Cmd+Right and Cmd+Backspace: line start, line end, delete to line start */
const CMD_LINE_KEYS: Record<string, string> = { ArrowLeft: '\x01', ArrowRight: '\x05', Backspace: '\x15' }
/** Option+Left/Right jump a word in readline, zsh and Claude Code */
const OPTION_WORD_KEYS: Record<string, string> = { ArrowLeft: '\x1bb', ArrowRight: '\x1bf' }

export function terminalKey(event: KeyChord, isMac: boolean): KeyAction {
  const { key, code, metaKey, altKey, ctrlKey, shiftKey } = event
  // An input method owns keys while it composes (Japanese, Korean, Chinese, dead keys); xterm feeds it the composition
  if (event.isComposing || event.keyCode === 229) return XTERM
  // xterm sends a plain Enter for Shift+Enter, which submits in Claude Code; Esc+Enter inserts a newline there and in zsh
  if (key === 'Enter' && shiftKey && !metaKey && !altKey && !ctrlKey) return { type: 'send', data: '\x1b\r' }
  // Ctrl+Tab and Ctrl+Shift+Tab switch tabs in the app
  if (ctrlKey && code === 'Tab') return APP
  return isMac ? macKey(event) : linuxKey(event)
}

function macKey({ key, code, metaKey, altKey, ctrlKey, shiftKey }: KeyChord): KeyAction {
  if (metaKey) {
    const plainCmd = !altKey && !ctrlKey && !shiftKey
    if (plainCmd && CMD_LINE_KEYS[key]) return { type: 'send', data: CMD_LINE_KEYS[key] }
    // Cmd+K is the palette (prototype), so clear takes Shift+Cmd+K
    if (shiftKey && !altKey && !ctrlKey && code === 'KeyK') return { type: 'clear' }
    if (plainCmd && code === 'KeyF') return { type: 'find' }
    // Cmd+C and Cmd+V reach the Edit menu, whose copy and paste events xterm handles (bracketed paste included);
    // reading the clipboard from JS would make WKWebView show its Paste callout. Every other Cmd chord is the app's
    return APP
  }
  // macOptionIsMeta stays off so Option types characters like ą and ś, so word jumps are mapped by hand
  if (altKey && !ctrlKey && !shiftKey && OPTION_WORD_KEYS[key]) return { type: 'send', data: OPTION_WORD_KEYS[key] }
  return XTERM
}

/** Plain Ctrl chords belong to the shell; Ctrl+Shift ones are the app's, with C, V, F and K copying, pasting, finding and clearing like GNOME Terminal */
function linuxKey({ code, altKey, ctrlKey, shiftKey }: KeyChord): KeyAction {
  if (!ctrlKey || !shiftKey || altKey) return XTERM
  if (code === 'KeyC') return { type: 'copy' }
  if (code === 'KeyV') return { type: 'paste' }
  if (code === 'KeyF') return { type: 'find' }
  if (code === 'KeyK') return { type: 'clear' }
  return APP
}
