import { Component, type ErrorInfo, type ReactNode } from 'react'
import { copyText } from './contextMenu'
import { EmptyState, errorMessage } from './ui'

type Props = {
  /** Names the area in the fallback, e.g. "Pull requests" */
  label: string
  /** A new value clears the error, e.g. after switching tabs or files */
  resetKey?: string
  /** The whole window: retrying reloads instead of re-rendering */
  root?: boolean
  children: ReactNode
}

type State = { error: unknown; stack: string }

/** Keeps a render error in one tab, panel or file from blanking the whole window */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: '' }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`[${this.props.label}]`, error, info.componentStack)
    this.setState({ stack: `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n${info.componentStack ?? ''}` })
  }

  componentDidUpdate(previous: Props): void {
    if (this.state.error !== null && previous.resetKey !== this.props.resetKey) this.setState({ error: null, stack: '' })
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children
    const { label, root } = this.props
    return (
      <EmptyState
        fill
        icon="alert"
        title={
          <>
            {label} hit an error
            <span className="mt-2 block font-mono text-[11.5px] break-words text-red-400 select-text">{errorMessage(this.state.error)}</span>
          </>
        }
      >
        <button
          onClick={() => (root ? window.location.reload() : this.setState({ error: null, stack: '' }))}
          className="h-7 rounded-md bg-primary px-3 text-xs font-medium text-white"
        >
          {root ? 'Reload window' : 'Try again'}
        </button>
        <button onClick={() => copyText(this.state.stack)} className="h-7 rounded-md px-2.5 text-xs ring-1 ring-input hover:bg-accent">
          Copy details
        </button>
      </EmptyState>
    )
  }
}
