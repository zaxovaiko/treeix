import type { RendererPlugin } from '@treeix/sdk'
import { Card, Row, Switch } from '@treeix/app/settingsUi'
import { updateSettings, useSettings } from '@treeix/app/settings'
import { MENU_BAR_OPTIONS, setMenuBarLabel, UsageLimits, usageSettings } from './UsageLimits'

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
  const { menuBarLabel } = usageSettings.useValue()
  const { menuBarIcon } = useSettings()
  return (
    <Card title="Menu bar">
      <Row label="Show in the menu bar" description="Treeix beside the clock, with Claude's and Codex's limits; clicking it lists every number.">
        <Switch checked={menuBarIcon} onChange={() => updateSettings({ menuBarIcon: !menuBarIcon })} label="Show in the menu bar" />
      </Row>
      <Row label="Next to the icon" description="Claude, then Codex.">
        <Choices options={MENU_BAR_OPTIONS} value={menuBarLabel} onPick={setMenuBarLabel} />
      </Row>
    </Card>
  )
}

const plugin: RendererPlugin = {
  titleBar: [{ order: 10, render: UsageLimits }],
  Settings: UsageSettings
}

export default plugin
