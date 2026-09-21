/** The newest slot that is actually visible: connected to the DOM and non-empty */
export const pickWinner = (candidates: HTMLDivElement[]): HTMLDivElement | null => {
  for (let index = candidates.length - 1; index >= 0; index--) {
    const element = candidates[index]
    const rect = element.getBoundingClientRect()
    if (element.isConnected && rect.width > 0 && rect.height > 0) return element
  }
  return null
}
