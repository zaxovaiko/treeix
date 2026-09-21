import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import type { ChatAdapter } from './chat'

export type * from './chat'

/** A command line tool the plugin relies on, shown with its version and sign-in state in Settings */
export type ToolDefinition = {
  name: string
  purpose: string
  /** Runs `<name> auth status` and lists the signed-in accounts */
  auth: boolean
  /** JSON endpoint with the latest release and the field holding its version, for the update check */
  releases?: { url: string; field: 'tag_name' | 'version' }
  /** How the tool updates itself when it wasn't installed by a package manager, e.g. "claude update" */
  selfUpdate?: string
}

export type MainContext = {
  /** Answers `invoke(channel)` from the plugin's renderer module; handlers trust arguments from the app's own renderer */
  handle: <Args extends unknown[]>(channel: string, handler: (event: IpcMainInvokeEvent, ...args: Args) => unknown) => void
  /** Receives `send(channel)` from the plugin's renderer module, which doesn't wait for an answer */
  on: <Args extends unknown[]>(channel: string, listener: (event: IpcMainEvent, ...args: Args) => void) => void
  /** Pushes an event to the plugin's listeners in every window */
  broadcast: (channel: string, ...args: unknown[]) => void
  /** Pushes an event to one window */
  send: (target: WebContents, channel: string, ...args: unknown[]) => void
  /** Folder for the plugin's own files in app data */
  dataPath: string
  /** Environment other enabled plugins add to new terminal sessions */
  sessionEnv: () => Promise<Record<string, string>>
  /** Runs when the plugin is disabled or the app quits */
  onDispose: (dispose: () => void) => void
  /** An adapter contributed by any enabled plugin */
  chatAdapter: (id: string) => ChatAdapter | null
}

export type MainPlugin = {
  tools?: ToolDefinition[]
  /** Registers handlers and starts background work; only called while the plugin is enabled */
  activate?: (context: MainContext) => void
  /** Variables added to every new terminal session while enabled */
  sessionEnv?: () => Promise<Record<string, string>>
  /** Chat adapters this plugin offers; the chat plugin connects agents through them by id */
  chatAdapters?: ChatAdapter[]
}
