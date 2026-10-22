/** Characters a shell would read as syntax, the set Ghostty escapes on drop */
const SHELL_SPECIAL = /[\\ ()[\]{}<>"'`!#$&;|*?\t]/g

export const shellEscape = (path: string): string => path.replace(SHELL_SPECIAL, '\\$&')

/** What a file drop types into the terminal: escaped paths, space-separated */
export const dropText = (paths: string[]): string => paths.map(shellEscape).join(' ')
