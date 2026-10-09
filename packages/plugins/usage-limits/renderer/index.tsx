import type { RendererPlugin } from '@treeix/sdk'
import { Card, Row } from '@treeix/app/settingsUi'
import { MENU_BAR_OPTIONS, setMenuBarLabel, USAGE_LABELS, UsageLimits, usageSettings } from './UsageLimits'

function Choices<Id extends string>({ options, value, onPick }: { options: [Id, string, string][]; value: Id; onPick: (id: Id) => void }): React.JSX.Element {
  return (
    <div data-segmented className="flex max-w-full shrink-0 flex-col gap-0.5 rounded-lg bg-muted p-1 ring-1 ring-border">
      {options.map(([id, name, example]) => (
        <button
          key={id}
          aria-pressed={value === id}
          onClick={() => onPick(id)}
          className={`flex h-7 w-80 max-w-full items-center gap-3 rounded-md px-2.5 text-left text-xs whitespace-nowrap ${
            value === id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <span className="min-w-0 flex-1 truncate">{name}</span>
          <span className="min-w-0 truncate font-mono text-[10.5px] whitespace-pre text-muted-foreground">{example}</span>
        </button>
      ))}
    </div>
  )
}

function UsageSettings(): React.JSX.Element {
  const { usageLabel, menuBarLabel } = usageSettings.use()
  return (
    <>
      <Card title="Title bar">
        <Row
          label="Title bar label"
          description="Claude numbers come from the newest of Claude sessions started here, the Claude desktop app or LimitBar; Codex numbers from its latest session log."
        >
          <Choices options={USAGE_LABELS} value={usageLabel} onPick={(id) => usageSettings.update({ usageLabel: id })} />
        </Row>
      </Card>
      <Card title="Menu bar">
        <Row label="Next to the icon" description="Claude, then Codex. Turn the menu bar icon on under General; its menu lists every number.">
          <Choices options={MENU_BAR_OPTIONS} value={menuBarLabel} onPick={setMenuBarLabel} />
        </Row>
      </Card>
    </>
  )
}

const plugin: RendererPlugin = {
  titleBar: [{ order: 10, render: UsageLimits }],
  Settings: UsageSettings
}

export default plugin
