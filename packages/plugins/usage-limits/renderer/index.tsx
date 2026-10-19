import type { RendererPlugin } from '@treeix/sdk'
import { Select } from '@treeix/app/Picker'
import { Card, Row, Switch } from '@treeix/app/settingsUi'
import { updateSettings, useSettings } from '@treeix/app/settings'
import { isMenuBarLabel } from '../shared/types'
import { MENU_BAR_OPTIONS, setMenuBarLabel, UsageLimits, usageSettings } from './UsageLimits'

function UsageSettings(): React.JSX.Element {
  const { menuBarLabel } = usageSettings.useValue()
  const { menuBarIcon } = useSettings()
  return (
    <Card title="Menu bar">
      <Row label="Show in the menu bar" description="Treeix beside the clock, with Claude's and Codex's limits; clicking it lists every number.">
        <Switch checked={menuBarIcon} onChange={() => updateSettings({ menuBarIcon: !menuBarIcon })} label="Show in the menu bar" />
      </Row>
      <Row label="Next to the icon" description="Claude, then Codex.">
        <Select
          title="Next to the icon"
          width="w-80"
          value={menuBarLabel}
          options={MENU_BAR_OPTIONS.map(([value, label, hint]) => ({ value, label, hint: hint || undefined }))}
          onChange={(value) => isMenuBarLabel(value) && setMenuBarLabel(value)}
        />
      </Row>
    </Card>
  )
}

const plugin: RendererPlugin = {
  titleBar: [{ order: 10, render: UsageLimits }],
  Settings: UsageSettings
}

export default plugin
