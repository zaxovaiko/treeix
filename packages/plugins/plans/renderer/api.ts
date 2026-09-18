import { createBridge } from '@treeix/sdk'
import type { Plan } from '../shared/types'

const bridge = createBridge('plans')

export const listPlans = (): Promise<Plan[]> => bridge.invoke<Plan[]>('list')
export const readPlan = (name: string): Promise<string | null> => bridge.invoke<string | null>('read', name)
