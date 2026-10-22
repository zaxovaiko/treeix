/** `auto` draws with WebGL on macOS and the DOM renderer on Linux, where WebKitGTK often falls back to software GL */
export type Renderer = 'auto' | 'webgl' | 'dom'

/** Lost WebGL contexts (GPU resets, context limits) after which every terminal stays on the DOM renderer */
export const MAX_WEBGL_LOSSES = 3

export function wantsWebgl(renderer: Renderer, isLinux: boolean, losses: number): boolean {
  if (losses >= MAX_WEBGL_LOSSES) return false
  return renderer === 'webgl' || (renderer === 'auto' && !isLinux)
}
