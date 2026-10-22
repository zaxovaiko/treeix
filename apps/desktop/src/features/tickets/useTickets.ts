import { useEffect, useState } from 'react'
import type { Api, Settings, TicketList } from '../../ipc/api'

const NONE: TicketList = { tickets: [], errors: [] }

/** Your Jira and Notion tickets, loaded once while either integration is on */
export function useTickets(api: Api, settings: Settings | null): TicketList {
  const on = !!settings && (settings.features.jira || settings.features.notion)
  const [list, setList] = useState(NONE)
  useEffect(() => {
    if (!on) return
    let live = true
    void api.myTickets().then((l) => live && setList(l), () => {})
    return () => {
      live = false
    }
  }, [api, on])
  return on ? list : NONE
}
