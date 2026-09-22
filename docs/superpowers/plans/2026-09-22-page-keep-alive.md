# Page Keep-Alive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Visited plugin pages stay mounted and hidden instead of being thrown away, so coming back to a page is instant.

**Architecture:** Today `App.tsx` renders only the active plugin tab, so every switch unmounts one page and builds the next from scratch, markdown parsing included. The fix renders every visited plugin tab, hides the inactive ones with the `hidden` attribute, and wraps each in its own `HostContext` whose `activePage` is that tab's id, exactly as the split pane already does. Two shared pieces have to learn about hidden pages: zone picking, which must skip zones with no layout box, and `TabDock`, which must draw the bottom dock only around the page on screen.

**Tech Stack:** React 19, Electron, TypeScript, bun test, the CDP stress suite in `apps/desktop/scripts/stress.ts`.

**Spec:** This document; the measurements below stand in for a separate spec.

## Background: what was measured

Both numbers come from the real app driven over CDP, with the user's own repositories and pull requests, on 2026-09-22.

| Build | Pull requests | Env | Worktrees | Terminal, Browser, Tasks, Confluence |
| --- | --- | --- | --- | --- |
| Packaged (`bun run --cwd apps/desktop build`) | 0 ms blocked | 0 ms | 0 ms | 0 ms |
| Dev (`bun run dev`) | 764-833 ms blocked per visit, worst single task 262 ms | ~130 ms | ~70 ms | 0 ms |

After keep-alive (dev, same machine and data): every switch costs 180-215 ms in one task, in both directions, instead of 764-833 ms for Pull requests; idle stays at 0, and the packaged build still shows 0. What is left is `jsxDEV` building the shell's own elements on each render, not the pages, which the packaged build does not pay.

Profile of one Pull requests switch in dev: `jsxDEV` 194 ms, garbage collection 137 ms, `react-markdown` parsing ~100 ms, the rest smaller. That is the cost of building the page again, which keep-alive removes in both builds.

## Global Constraints

- No new dependencies.
- TypeScript: never `any`; `unknown` only at trust boundaries, narrowed with a type guard.
- Tests are pure functions run by `bun test`; the repo has no DOM or component test setup, so component behaviour is verified by `apps/desktop/scripts/stress.ts` instead.
- `bun run typecheck` and `bun run test` must pass at the end of every task.
- The stress suite must stay green: `bun run --cwd apps/desktop stress`.
- Keep-alive covers plugin tabs only. Worktrees, Settings and document tabs keep today's behaviour.
- `host.activeTab` keeps naming the tab actually on screen; only `host.activePage` differs per kept page.
- Conventional commit messages, one commit per task.

## Review Focus

1. A plugin switched off in Settings while its page is kept: the kept list must drop it, or the app renders a tab that no longer exists. Covered in Task 3, `keptPages` test "drops a page whose plugin is gone".
2. Switching workspace: every kept page must be rebuilt for the new workspace, or a page shows the previous workspace's data. Covered in Task 3, the effect that clears `visitedTabs` on `workspaceId` (Step 5) and the by-hand check in Step 9, which switches workspace with two workspaces present and confirms each page reloads its own data.
3. Keyboard focus after a switch: `focusZone` must land in the page on screen, not in a hidden page's list. Covered in Task 1, `chooseZone` tests.
4. A terminal revealed again must be sized to its pane, not to the zero-sized box it had while hidden. Covered in Task 4, stress check "terminal is sized after coming back".
5. The bottom dock must be drawn once, around the page on screen. Covered in Task 2 and the stress check "one dock frame with several pages kept".

---

### Task 1: Zone picking skips hidden zones

**Files:**
- Modify: `packages/sdk/src/layout.tsx:101-106` (`zoneElement`) and `packages/sdk/src/layout.tsx:214-261` (`Zone`, the label effect)
- Test: `packages/sdk/src/layout.test.ts` (create)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `export function chooseZone<T>(candidates: T[], shown: (candidate: T) => boolean, contains: (outer: T, inner: T) => boolean): T | null`

- [ ] **Step 1: Write the failing test**

Create `packages/sdk/src/layout.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { chooseZone } from './layout'

type Fake = { id: string; shown: boolean; inside: string[] }

const shown = (zone: Fake): boolean => zone.shown
const contains = (outer: Fake, inner: Fake): boolean => outer.inside.includes(inner.id)

test('chooseZone takes the innermost zone that is on screen', () => {
  const shell: Fake = { id: 'shell', shown: true, inside: ['page'] }
  const page: Fake = { id: 'page', shown: true, inside: [] }
  expect(chooseZone([shell, page], shown, contains)).toBe(page)
})

test('chooseZone ignores zones of a hidden page, so its shell zone wins', () => {
  const shell: Fake = { id: 'shell', shown: true, inside: ['hidden'] }
  const hidden: Fake = { id: 'hidden', shown: false, inside: [] }
  expect(chooseZone([shell, hidden], shown, contains)).toBe(shell)
})

test('chooseZone returns null when every zone is hidden', () => {
  expect(chooseZone([{ id: 'a', shown: false, inside: [] }], shown, contains)).toBeNull()
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `bun test packages/sdk/src/layout.test.ts`
Expected: FAIL, `chooseZone` is not exported by `./layout`.

- [ ] **Step 3: Add the helper and use it**

In `packages/sdk/src/layout.tsx`, replace the `zoneElement` function:

```tsx
/** The zone to act on: the innermost one that has a layout box, so zones of hidden pages are passed over */
export function chooseZone<T>(candidates: T[], shown: (candidate: T) => boolean, contains: (outer: T, inner: T) => boolean): T | null {
  const visible = candidates.filter(shown)
  return visible.find((candidate) => !visible.some((other) => other !== candidate && contains(candidate, other))) ?? null
}

function zoneElement(zone: ZoneId): HTMLElement | null {
  const all = [...document.querySelectorAll<HTMLElement>(`[data-zone="${zone}"]`)]
  return chooseZone(
    all,
    (element) => element.checkVisibility(),
    (outer, inner) => outer !== inner && outer.contains(inner)
  )
}
```

- [ ] **Step 4: Let a hidden inner zone keep its outer zone's status bar label**

In the `Zone` component's effect, replace the nested check so only a zone on screen counts:

```tsx
  useEffect(() => {
    // The shell's main zone around a page's own main zone leaves the status bar to the inner one, unless that page is hidden
    const inner = [...(ref.current?.querySelectorAll<HTMLElement>(`[data-zone="${id}"]`) ?? [])].some((element) => element.checkVisibility())
    if (!focused || inner) return
    updateShell({ zoneLabel: label ?? ZONE_LABELS[id], hints: hints ?? [] })
  }, [focused, label, hintKey])
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `bun test packages/sdk/src/layout.test.ts && bun run typecheck`
Expected: 3 pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/layout.tsx packages/sdk/src/layout.test.ts
git commit -m "fix(sdk): pick the zone that is on screen, not one of a hidden page"
```

---

### Task 2: The bottom dock is drawn only around the page on screen

**Files:**
- Modify: `apps/desktop/src/renderer/src/App.tsx:160-183` (`TabDock`, which starts at line 160)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `TabDock` takes `active?: boolean` (default `true`); when false it renders its children with no dock frames and no `DockSlot`.

- [ ] **Step 1: Give TabDock an `active` flag**

Replace the component in `apps/desktop/src/renderer/src/App.tsx`:

```tsx
function TabDock({
  placement,
  withDock,
  active = true,
  children
}: {
  placement: Settings['bottomPanel']
  withDock: (content: React.ReactNode, frames: boolean) => React.ReactNode
  /** False for a page kept mounted off screen: the dock belongs to the page the user is looking at */
  active?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const [claims, setClaims] = useState(0)
  // Children claim in their layout effects, which run before this one, so the first paint already knows
  const [settled, setSettled] = useState(false)
  useLayoutEffect(() => setSettled(true), [])
  const claim = useCallback(() => {
    setClaims((count) => count + 1)
    return () => setClaims((count) => count - 1)
  }, [])
  if (!active) return <>{children}</>
  if (placement === 'full') return <>{withDock(children, true)}</>
  return <>{withDock(<DockSlot.Provider value={claim}>{children}</DockSlot.Provider>, settled && claims === 0)}</>
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: no errors. Nothing passes `active` yet, so behaviour is unchanged.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/App.tsx
git commit -m "refactor(app): let TabDock skip the dock for a page that is off screen"
```

---

### Task 3: Keep visited plugin pages mounted

**Files:**
- Create: `apps/desktop/src/renderer/src/keepAlive.ts`
- Create: `apps/desktop/src/renderer/src/keepAlive.test.ts`
- Modify: `apps/desktop/src/renderer/src/App.tsx` (state near `const [appTab, setAppTab] = useState(SAVED_PLACE.appTab)`, the host memo area around line 1280, and the render block at lines 1800-1817)

**Interfaces:**
- Consumes: `TabDock`'s `active` prop from Task 2.
- Produces: `export function keptPages<T extends { id: string }>(tabs: T[], visited: string[], activeTab: string): T[]`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/keepAlive.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { keptPages } from './keepAlive'

const tabs = [{ id: 'terminal' }, { id: 'browser' }, { id: 'prs' }]

test('keeps the pages already visited, in tab order, plus the active one', () => {
  expect(keptPages(tabs, ['browser'], 'prs').map((tab) => tab.id)).toEqual(['browser', 'prs'])
})

test('a page visited twice is kept once', () => {
  expect(keptPages(tabs, ['browser', 'browser'], 'browser').map((tab) => tab.id)).toEqual(['browser'])
})

test('drops a page whose plugin is gone', () => {
  expect(keptPages(tabs, ['jira'], 'terminal').map((tab) => tab.id)).toEqual(['terminal'])
})

test('a tab that is not a plugin page keeps nothing extra', () => {
  expect(keptPages(tabs, ['browser'], 'worktrees').map((tab) => tab.id)).toEqual(['browser'])
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `bun test apps/desktop/src/renderer/src/keepAlive.test.ts`
Expected: FAIL, the module does not exist.

- [ ] **Step 3: Write the helper**

Create `apps/desktop/src/renderer/src/keepAlive.ts`:

```ts
/**
 * The plugin pages that stay mounted: the ones visited in this workspace, in tab order, with the active page always
 * among them. A page of a plugin switched off in the meantime is dropped, since there is nothing left to render.
 */
export function keptPages<T extends { id: string }>(tabs: T[], visited: string[], activeTab: string): T[] {
  const keep = new Set([...visited, activeTab])
  return tabs.filter((tab) => keep.has(tab.id))
}
```

- [ ] **Step 4: Run the test**

Run: `bun test apps/desktop/src/renderer/src/keepAlive.test.ts`
Expected: 4 pass.

- [ ] **Step 5: Track the pages visited**

In `apps/desktop/src/renderer/src/App.tsx`, next to the other tab state (`const [appTab, setAppTab] = useState(SAVED_PLACE.appTab)`), add:

```tsx
  /** Plugin pages seen in this workspace; they stay mounted so coming back to one is instant */
  const [visitedTabs, setVisitedTabs] = useState<string[]>([])
  useEffect(() => setVisitedTabs((list) => (list.includes(appTab) ? list : [...list, appTab])), [appTab])
  useEffect(() => setVisitedTabs([]), [workspaceId])
```

Add the import at the top of the file:

```tsx
import { keptPages } from './keepAlive'
```

- [ ] **Step 6: Give each kept page its own host**

Below the `splitHost` memo (around line 1282), add:

```tsx
  const keptTabs = keptPages(pluginTabs, visitedTabs, appTab)
  const keptIds = keptTabs.map((tab) => tab.id).join()
  // A kept page reads its own panels and widths; `activeTab` still names the page the user is looking at
  const pageHosts = useMemo(() => new Map(keptTabs.map((tab): [string, HostApi] => [tab.id, { ...host, activePage: tab.id }])), [host, keptIds])
```

- [ ] **Step 7: Render every kept page, hiding the ones off screen**

Replace the block at `apps/desktop/src/renderer/src/App.tsx:1805-1812` (the `activePluginTab && …` expression) with:

```tsx
      {keptTabs.map((tab) => {
        const onScreen = tab.id === appTab
        const page = tab.panels?.length ? (
          <TabDock placement={settings.bottomPanel} withDock={withDock} active={onScreen}>
            <tab.render />
          </TabDock>
        ) : (
          <tab.render />
        )
        return (
          // `hidden` takes the page out of layout and out of the zones, and keeps its state and its DOM alive
          <div key={tab.id} hidden={!onScreen} className={onScreen ? 'flex min-h-0 min-w-0 flex-1 flex-col' : undefined}>
            <HostContext.Provider value={pageHosts.get(tab.id) ?? host}>
              <ErrorBoundary label={tab.label} resetKey={`${workspaceId}:${tab.id}`}>
                {page}
              </ErrorBoundary>
            </HostContext.Provider>
          </div>
        )
      })}
```

- [ ] **Step 8: Typecheck and run every test**

Run: `bun run typecheck && bun run test`
Expected: no type errors, every test passes.

- [ ] **Step 9: Look at it in the app**

Run: `bun run --cwd apps/desktop build && bun apps/desktop/scripts/stress.ts page-switching --open`
Check by hand in the window it leaves open:
- Switch Terminal, Browser, Pull requests, Worktrees, Env: each page shows its own panels, the bottom dock appears once, the terminal keeps its scrollback, ⌘⇧E toggles the list of the page on screen.
- Make a second workspace from the rail's +, switch to it and back: every page shows that workspace's data, not the other one's.
- Turn a plugin off in Settings while its page is kept: the tab and its page go away without an error.

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/src/renderer/src/keepAlive.ts apps/desktop/src/renderer/src/keepAlive.test.ts apps/desktop/src/renderer/src/App.tsx
git commit -m "perf(app): keep visited pages mounted so switching back is instant"
```

---

### Task 4: A revealed page is sized again

**Files:**
- Modify: `packages/plugins/terminal/renderer/TerminalPanel.tsx:210-220` (the pane's `ResizeObserver`) only if the check below fails
- Modify: `apps/desktop/scripts/stress.ts` (the `page-switching` case)

**Interfaces:**
- Consumes: keep-alive from Task 3.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Add the check to the page-switching case**

In `apps/desktop/scripts/stress.ts`, inside the `page-switching` case, after the switching loop and before `return`, add:

```ts
      // A terminal hidden by keep-alive is a zero-sized box; coming back must size it again
      await driver.evaluate(clickTitle('Terminal'))
      await driver.frames()
      await sleep(600)
      const sized = Number(await driver.evaluate(`Math.round(document.querySelector('.xterm canvas')?.getBoundingClientRect().width ?? 0)`))
      checks.push(sized > 100 ? `terminal is sized after coming back (${sized} px)` : `FAIL terminal came back ${sized} px wide`)
```

Declare `const checks: string[] = []` at the top of the case and return `[...checks, …]` together with the timing line the case already returns.

- [ ] **Step 2: Run the case**

Run: `bun run --cwd apps/desktop build && bun apps/desktop/scripts/stress.ts page-switching`
Expected: `ok page-switching` with "terminal is sized after coming back".

- [ ] **Step 3: Only if it fails, refit on reveal**

In `packages/plugins/terminal/renderer/TerminalPanel.tsx`, next to the pane's observer:

```tsx
    // A pane revealed again reports its size through the observer, except when the browser skips a zero to real jump
    const observer = new ResizeObserver(() => fitSession(session.id))
    observer.observe(element)
    const onReveal = (): void => void (element.checkVisibility() && fitSession(session.id))
    document.addEventListener('visibilitychange', onReveal)
```

and remove the listener in the same cleanup that disconnects the observer.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/scripts/stress.ts packages/plugins/terminal/renderer/TerminalPanel.tsx
git commit -m "test(stress): check a terminal is sized after its page comes back"
```

---

### Task 5: Prove keep-alive in the stress suite

**Files:**
- Modify: `apps/desktop/scripts/stress.ts` (new case, and the case list in the header comment)

**Interfaces:**
- Consumes: keep-alive from Task 3.
- Produces: the `page-keepalive` case.

- [ ] **Step 1: Add the case**

In `apps/desktop/scripts/stress.ts`, add to `CASES` after `page-switching`:

```ts
  {
    name: 'page-keepalive',
    budget: { maxFrame: 250, p95Frame: 34 },
    run: async (driver) => {
      // A mark on the page's own DOM survives only while the page stays mounted
      await driver.evaluate(clickTitle('Pull requests'))
      await driver.frames()
      await sleep(1500)
      await driver.evaluate(`(document.querySelector('[data-zone="main"]').dataset.stressMark = 'kept')`)
      await driver.evaluate(clickTitle('Terminal'))
      await driver.frames()
      await sleep(400)
      await driver.evaluate(`window.__lt = []`)
      await driver.evaluate(`(() => { if (window.__revisit) return; window.__revisit = []; new PerformanceObserver((list) => list.getEntries().forEach((entry) => window.__revisit.push(entry.duration))).observe({ type: 'longtask' }) })()`)
      await driver.evaluate(`window.__revisit = []`)
      await driver.evaluate(clickTitle('Pull requests'))
      await driver.frames()
      await sleep(1500)
      const kept = await driver.evaluate(`document.querySelector('[data-zone="main"]')?.dataset.stressMark ?? ''`)
      const blocked = Math.round(Number(await driver.evaluate(`(window.__revisit ?? []).reduce((sum, value) => sum + value, 0)`)))
      const docks = Number(await driver.evaluate(`document.querySelectorAll('[data-dock-frame]').length`))
      return [
        kept === 'kept' ? 'the page came back mounted' : 'FAIL the page was rebuilt',
        blocked <= 120 ? `revisit blocked ${blocked} ms` : `FAIL revisit blocked ${blocked} ms`,
        docks <= 1 ? 'one dock frame with several pages kept' : `FAIL ${docks} dock frames`
      ]
    }
  },
```

- [ ] **Step 2: Mark the dock frame so the case can count it**

In `apps/desktop/src/renderer/src/App.tsx:1130-1133`, `dockFrame` builds an `<aside>`; add the marker to it:

```tsx
    const aside = (
      <aside
        data-dock-frame
        style={side === 'bottom' ? { height: size } : { width: size }}
        className={`relative flex min-h-0 min-w-0 shrink-0 flex-col border-border bg-card ${frame} ${side === 'bottom' ? '' : 'flex-1'}`}
```

- [ ] **Step 3: Run the new case**

Run: `bun run --cwd apps/desktop build && bun apps/desktop/scripts/stress.ts page-keepalive`
Expected: `ok page-keepalive` with "the page came back mounted", "revisit blocked …", "one dock frame with several pages kept".

- [ ] **Step 4: Add it to the header comment**

In `apps/desktop/scripts/stress.ts`, extend the `Cases:` line with `page-keepalive`.

- [ ] **Step 5: Run the whole suite**

Run: `bun run --cwd apps/desktop stress`
Expected: every case `ok`, exit code 0.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/scripts/stress.ts apps/desktop/src/renderer/src/App.tsx
git commit -m "test(stress): cover page keep-alive"
```

---

### Task 6: Measure the dev win and write it down

**Files:**
- Modify: `docs/architecture.md` (the paragraph about pages and plugins)

**Interfaces:**
- Consumes: everything above.
- Produces: the numbers to report.

- [ ] **Step 1: Measure the dev build again**

Start a dev instance on its own data: `TREEIX_USER_DATA=/tmp/treeix-keepalive npx electron-vite dev --remoteDebuggingPort 9336` from `apps/desktop`, then measure blocking per switch with a short CDP script that clicks each tab and reads `longtask` entries, the same way the numbers in Background were taken. Expect Pull requests to fall from ~800 ms per revisit to under ~150 ms, since only the first visit builds the page.

- [ ] **Step 2: Record the result in the plan**

Add a line under Background: `After keep-alive (dev): Pull requests first visit <x> ms, revisit <y> ms.`

- [ ] **Step 3: Document the behaviour**

In `docs/architecture.md`, next to the description of tabs and plugin pages, add:

```markdown
Plugin pages stay mounted once visited: the page the user is looking at is the only one with a layout box, the others keep their state behind the `hidden` attribute. Each kept page renders under its own `HostApi` whose `activePage` is that page, so `PageLayout` reads that page's panels, and zone picking skips zones with no layout box.
```

- [ ] **Step 4: Commit**

```bash
git add docs/architecture.md docs/superpowers/plans/2026-09-22-page-keep-alive.md
git commit -m "docs: describe page keep-alive and its measurements"
```

---

## Rollback

If a kept page misbehaves in a way that cannot be fixed quickly, replace the map in Task 3 Step 7 with `keptTabs.filter((tab) => tab.id === appTab).map(…)`. That restores today's behaviour and keeps every other change harmless.
