import type { ComponentType } from 'react'

export type PlansService = {
  /** Opens the newest plan written since `startedAt`; renders nothing until there is one */
  PlanButton: ComponentType<{ startedAt: number }>
}

declare module '@treeix/sdk' {
  interface Services {
    plans: PlansService
  }
}
