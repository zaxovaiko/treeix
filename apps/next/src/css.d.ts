import 'react'

declare module 'react' {
  interface CSSProperties {
    /** Place color read by .wt, .gchip and crumbs */
    '--c'?: string
  }
}
