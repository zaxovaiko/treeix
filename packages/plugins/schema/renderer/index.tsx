import { lazy, Suspense } from 'react'
import type { RendererPlugin } from '@treeix/sdk'

// React Flow loads with the page, on first open
const SchemaPage = lazy(() => import('./SchemaPage').then((module) => ({ default: module.SchemaPage })))

function Tab(): React.JSX.Element {
  return (
    <Suspense fallback={<div className="flex-1" />}>
      <SchemaPage />
    </Suspense>
  )
}

const plugin: RendererPlugin = {
  tabs: [{ id: 'schema', label: 'Schema', icon: 'database', order: 65, render: Tab, panels: ['terminal'] }]
}

export default plugin
