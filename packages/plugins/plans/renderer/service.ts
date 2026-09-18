import type { ComponentType } from 'react'

export type PlansService = {
  /** Opens the plan named in the session's output, else the newest written since `startedAt`; renders nothing until there is one */
  PlanButton: ComponentType<{ startedAt: number; name?: string | null }>
}

declare module '@treeix/sdk' {
  interface Services {
    plans: PlansService
  }
}
