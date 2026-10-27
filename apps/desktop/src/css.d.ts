import 'react'

declare module 'react' {
  interface CSSProperties {
    /** Place color read by .wt, .gchip and crumbs */
    '--c'?: string
    /** How full the usage ring is, 0-100 */
    '--p'?: number
  }
}
