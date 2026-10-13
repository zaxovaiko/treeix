import { lazy, Suspense } from 'react'
import type { RendererPlugin } from '@treeix/sdk'

// React Flow loads with the page, on first open
const DependenciesPage = lazy(() => import('./DependenciesPage').then((module) => ({ default: module.DependenciesPage })))

function Tab(): React.JSX.Element {
  return (
    <Suspense fallback={<div className="flex-1" />}>
      <DependenciesPage />
    </Suspense>
  )
}

const plugin: RendererPlugin = {
  tabs: [{ id: 'dependencies', label: 'Dependencies', icon: 'network', order: 66, render: Tab, panels: ['terminal'] }]
}

export default plugin
