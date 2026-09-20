import type { RendererPlugin } from '@treeix/sdk'
import { Row } from '@treeix/app/settingsUi'
import { USAGE_LABELS, UsageLimits, usageSettings } from './UsageLimits'

function UsageSettings(): React.JSX.Element {
  const { usageLabel } = usageSettings.use()
  return (
    <Row label="Title bar label" description="Claude numbers come from the newest of Claude sessions started here, the Claude desktop app or LimitBar; Codex numbers from its latest session log.">
      <div data-segmented className="flex max-w-full shrink-0 flex-col gap-0.5 rounded-lg bg-muted p-1 ring-1 ring-border">
        {USAGE_LABELS.map(([id, name, example]) => (
          <button
            key={id}
            aria-pressed={usageLabel === id}
            onClick={() => usageSettings.update({ usageLabel: id })}
            className={`flex h-7 w-80 max-w-full items-center gap-3 rounded-md px-2.5 text-left text-xs whitespace-nowrap ${
              usageLabel === id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <span className="min-w-0 flex-1 truncate">{name}</span>
            <span className="min-w-0 truncate font-mono text-[10.5px] whitespace-pre text-muted-foreground">{example}</span>
          </button>
        ))}
      </div>
    </Row>
  )
}

const plugin: RendererPlugin = {
  titleBar: [{ order: 10, render: UsageLimits }],
  Settings: UsageSettings
}

export default plugin
