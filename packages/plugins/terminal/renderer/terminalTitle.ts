const MAX_TITLE = 60

/**
 * The window title a program set (OSC 0/2) as a session name. Claude Code prefixes its topic with a
 * spinner or ✳ that changes every frame, so leading symbols are dropped to keep the name stable.
 */
export function terminalTitle(raw: string): string {
  const title = raw.replace(/^[^\p{L}\p{N}~/.]+/u, '').replace(/\s+/g, ' ').trim()
  return title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1)}…` : title
}
