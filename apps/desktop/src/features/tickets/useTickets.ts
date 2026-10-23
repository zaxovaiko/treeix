import { useEffect, useState } from 'react'
import type { Api, Settings, TicketList } from '../../ipc/api'

const NONE: TicketList = { tickets: [], errors: [] }

/** Your Jira and Notion tickets, loaded while either integration is on and again on `refresh` */
export function useTickets(api: Api, settings: Settings | null): TicketList & { refresh: () => void } {
  const on = !!settings && (settings.features.jira || settings.features.notion)
  const [list, setList] = useState(NONE)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!on) return
    let live = true
    void api.myTickets().then((l) => live && setList(l), () => {})
    return () => {
      live = false
    }
  }, [api, on, tick])
  return { ...(on ? list : NONE), refresh: () => setTick((n) => n + 1) }
}
