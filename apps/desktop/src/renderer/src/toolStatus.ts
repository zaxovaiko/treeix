/**
 * Which command line tools are missing, cached so a synchronous prompt can ask. A reference comment sends its own
 * text when the tool that would fetch it is not installed, since nothing on the machine could read it otherwise.
 */
let missing = new Set<string>()

export const missingTools = (): Set<string> => missing

export async function refreshToolStatus(): Promise<void> {
  const statuses = await window.api.checkTools().catch(() => [])
  // A null version means the binary is not on PATH; an error with a version still means it runs
  missing = new Set(statuses.filter((status) => status.version === null).map((status) => status.name))
}

/** What a reference comment does when the drawer has not been told otherwise */
export const inlineByDefault = (tool: string | undefined): boolean => Boolean(tool) && missing.has(tool as string)
