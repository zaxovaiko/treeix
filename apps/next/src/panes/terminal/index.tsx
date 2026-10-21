import type { Api } from '../../ipc/api'

export interface TerminalPaneProps {
  api: Api
  sessionId: string
  /** On screen: attached, WebGL alive. Hidden panes detach and free their renderer */
  visible: boolean
  focused: boolean
  onFocus(): void
}

export function TerminalPane(_: TerminalPaneProps) {
  return <div className="term" />
}
