import { useState } from 'react'
import { ListToggle, useHost } from '@treeix/sdk'
import { copyText } from '@treeix/app/contextMenu'
import { Icon } from '@treeix/app/Icon'
import { baseName, branchLabel } from '@treeix/app/Sidebar'
import { EmptyState, IconButton } from '@treeix/app/ui'
import { isSecretKind } from '../shared/classify'
import { folderOf, type Place, worstKind } from './model'
import { KindIcon, Pill, RowComments, ToggleButton, ValueInput, VarName } from './parts'
import { editKey, pending, type ScopedWorktree, setPending } from './store'
import type { RowState } from './WorktreeView'

const VARIANT_DOTS = ['bg-emerald-400', 'bg-amber-400', 'bg-sky-400', 'bg-violet-400', 'bg-red-400']

/** One name everywhere it is set or missing, with a dot per distinct value */
export function VariableMain({ name, places, scoped, state }: { name: string; places: Place[]; scoped: ScopedWorktree[]; state: RowState }): React.JSX.Element {
  const host = useHost()
  const edits = pending.use()
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulk, setBulk] = useState('')
  if (!places.length) return <EmptyState fill icon="braces" title="Pick a variable" />
  const set = places.filter((place) => place.value !== null)
  const counts = new Map<string, number>()
  set.forEach((place) => counts.set(place.value ?? '', (counts.get(place.value ?? '') ?? 0) + 1))
  const variants = [...counts].sort((a, b) => b[1] - a[1]).map(([value]) => value)
  const dot = (value: string): string => VARIANT_DOTS[variants.indexOf(value)] ?? 'bg-muted-foreground'
  const kind = worstKind(places.map((place) => place.kind))
  const openBulk = (): void => {
    // Plain values start from the most common one; secrets start empty so nothing is shown
    setBulk(kind === 'config' || kind === 'public' ? (variants[0] ?? '') : '')
    setBulkOpen(!bulkOpen)
  }
  const apply = (): void => {
    places.forEach((place) => setPending({ worktreePath: place.worktreePath, file: place.file, name, value: bulk }, place.value))
    setBulkOpen(false)
  }
  return (
    <>
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-1.5 text-[12px]">
        <ListToggle />
        <KindIcon kind={kind} className="size-3.5" />
        <span className="font-mono text-[12.5px]">
          <VarName name={name} kind={kind} />
        </span>
        <span className="text-muted-foreground">
          {set.length} file{set.length === 1 ? '' : 's'}
        </span>
        <span className="ml-1 flex items-center gap-1" title={`${variants.length} different value${variants.length === 1 ? '' : 's'}`}>
          {variants.map((value) => (
            <span key={value} className={`size-2 rounded-full ${dot(value)}`} />
          ))}
        </span>
        <span className="flex-1" />
        <ToggleButton label="Set in all" on={bulkOpen} onClick={openBulk}>
          <Icon name="pencil" className="size-3.5" />
        </ToggleButton>
        <IconButton label="Copy name" onClick={() => (copyText(name), host.flash(`Copied ${name}`))}>
          <Icon name="copy" className="size-3.5" />
        </IconButton>
      </header>
      {bulkOpen && (
        <div className="mx-2 mt-2 flex items-center gap-2 rounded-md bg-muted px-2.5 py-1.5 ring-1 ring-border">
          <span className="text-[11.5px] whitespace-nowrap text-muted-foreground">All {places.length} =</span>
          <input
            autoFocus
            value={bulk}
            type={isSecretKind(kind) ? 'password' : 'text'}
            onChange={(event) => setBulk(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && apply()}
            className="min-w-0 flex-1 rounded-[5px] bg-transparent px-1.5 py-0.5 font-mono text-[11.5px] ring-1 ring-input outline-none focus:ring-primary"
          />
          <button onClick={apply} className="h-6 shrink-0 rounded-md bg-primary px-2.5 text-[11.5px] font-medium text-white">
            Apply
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto pt-2 pb-16">
        {places.map((place) => {
          const key = editKey(place.worktreePath, place.file, name)
          const owner = scoped.find((candidate) => candidate.worktree.path === place.worktreePath)
          const secret = isSecretKind(place.kind)
          const missing = place.value === null
          const edit = edits.get(key)
          const folder = folderOf(place.file)
          return (
            <div key={key}>
              <div title={place.file} onClick={() => state.onSelect(key)} className={`group mx-2 flex h-8 items-center gap-2 rounded-md px-2.5 ${key === state.selected ? 'bg-accent' : 'hover:bg-accent'}`}>
                <span className={`size-2 shrink-0 rounded-full ${missing ? 'ring-1 ring-red-400' : dot(place.value ?? '')}`} />
                <span className="flex w-[340px] min-w-0 shrink-0 items-center gap-1.5 text-[11.5px]">
                  <span className="text-muted-foreground">{owner ? baseName(owner.repo.path) : ''}</span>
                  <span className="truncate font-mono text-foreground/85">{owner ? branchLabel(owner.worktree) : baseName(place.worktreePath)}</span>
                  {folder !== '.' && <span className="truncate font-mono text-[10.5px] text-muted-foreground/70">{folder}</span>}
                </span>
                <span className="min-w-0 flex-1">
                  <ValueInput
                    value={edit?.value ?? place.value ?? ''}
                    dirty={edit !== undefined}
                    masked={secret && !state.revealed.has(key)}
                    placeholder={missing ? 'empty' : ''}
                    onChange={(value) => setPending({ worktreePath: place.worktreePath, file: place.file, name, value }, place.value)}
                  />
                </span>
                {missing ? <Pill tone="red">missing</Pill> : place.kind === 'exposed' ? <Pill tone="red">exposed</Pill> : null}
                <span className="hidden text-muted-foreground group-hover:flex">
                  {secret && !missing && (
                    <IconButton label={state.revealed.has(key) ? 'Hide (v)' : 'Reveal (v)'} onClick={() => state.toggleReveal(key)}>
                      <Icon name="eye" className="size-3.5" />
                    </IconButton>
                  )}
                  <IconButton label="Comment to agent (c)" onClick={() => state.setComposing({ key, prefill: '' })}>
                    <Icon name="comment" className="size-3.5" />
                  </IconButton>
                </span>
              </div>
              <RowComments
                worktreePath={place.worktreePath}
                file={place.file}
                line={place.line}
                name={name}
                secret={secret}
                composing={state.composing?.key === key}
                prefill={state.composing?.prefill ?? ''}
                onClose={() => state.setComposing(null)}
                indent="ml-5"
              />
            </div>
          )
        })}
      </div>
    </>
  )
}
