'use strict'

// Treeix on the phone: agents, chats and routines from ptyd over `tailscale serve`.
// CSP allows no inline code or style attributes: text goes in via textContent, styles via the CSSOM

const KIND = { Shell: 'Shell', Claude: 'Claude', Codex: 'Codex', Routine: 'Routine' }
const SESSION_STATUS = {
  Running: ['working', 'Working'],
  Watching: ['working', 'Watching'],
  Needs: ['needs', 'Needs you'],
  Done: ['done', 'Done'],
  Idle: ['idle', 'Idle'],
  Exited: ['idle', 'Exited'],
  Error: ['error', 'Error'],
  Crashed: ['error', 'Crashed'],
  Restored: ['restored', 'Restored'],
}
const CHAT_STATUS = {
  starting: ['working', 'Starting'],
  running: ['working', 'Working'],
  needs: ['needs', 'Needs you'],
  idle: ['idle', 'Idle'],
  disconnected: ['error', 'Disconnected'],
}
const TOOL_STATUS = { pending: 'idle', in_progress: 'working', completed: 'done', failed: 'error' }
const EVENTS = {
  reviewRequested: 'Review requested',
  ciFailed: 'CI failed',
  prComment: 'PR comment',
  ticketAssigned: 'Ticket assigned',
}
const CAUSE = { schedule: 'Scheduled', catchUp: 'Caught up', event: 'Event', webhook: 'Webhook', manual: 'Manual' }
const RUN_STATUS = {
  queued: 'Queued',
  running: 'Running',
  ok: 'Done',
  failed: 'Failed',
  overBudget: 'Over budget',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
}
// Two rows of seven, Enter spans two: label, bytes, spoken name
const KEYS = [
  ['Esc', '\x1b', 'Escape'],
  ['Tab', '\t', 'Tab'],
  ['^C', '\x03', 'Control C'],
  ['←', '\x1b[D', 'Left'],
  ['↑', '\x1b[A', 'Up'],
  ['↓', '\x1b[B', 'Down'],
  ['→', '\x1b[C', 'Right'],
  ['1', '1'],
  ['2', '2'],
  ['3', '3'],
  ['y', 'y'],
  ['n', 'n'],
  ['Enter', '\r'],
]
const FLAGS = [[1, 'b'], [2, 'i'], [4, 'u'], [16, 'd'], [32, 's'], [64, 'h']]
const FONT_KEY = 'treeix.font'
const FIT_KEY = 'treeix.fit'
// A request the phone dropped while asleep or switching networks would otherwise hold the poller forever
const TIMEOUT = 8000
// A row of box-drawing rules, like the lines around an agent's prompt
const RULE = /^[\s─━═┄┈╌-]{8,}$/

const app = document.getElementById('app')
const host = location.hostname.split('.')[0]
let current = null
let inApp = false

function $(tag, props = {}, ...kids) {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue
    if (key === 'class') el.className = value
    else if (key === 'text') el.textContent = value
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value)
    else el.setAttribute(key, value === true ? '' : value)
  }
  el.append(...kids.filter((kid) => kid != null && kid !== false))
  return el
}

async function api(path, body) {
  const init = body === undefined
    ? {}
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
  init.signal = AbortSignal.timeout(TIMEOUT)
  let res
  try {
    res = await fetch(path, init)
  } catch {
    throw new Error("Can't reach the Mac")
  }
  if (!res.ok) throw new Error((await res.text()) || res.statusText)
  return res.status === 204 ? null : res.json()
}

/** Runs `fn` now and every `every` ms while the page is visible, one call at a time */
function poller(every, fn, fail) {
  let timer = 0
  let busy = false
  let again = false
  let stopped = false
  async function run() {
    clearTimeout(timer)
    if (stopped || document.hidden) return
    if (busy) {
      again = true
      return
    }
    busy = true
    try {
      await fn()
    } catch (e) {
      fail(e)
    } finally {
      busy = false
    }
    if (again) {
      again = false
      return run()
    }
    if (!stopped) timer = setTimeout(run, every)
  }
  // Back from the lock screen or the tab switcher, or the network came back
  const wake = ['visibilitychange', 'pageshow', 'online']
  for (const name of wake) window.addEventListener(name, run)
  run()
  return {
    now: run,
    soon: () => setTimeout(run, 150),
    stop() {
      stopped = true
      clearTimeout(timer)
      for (const name of wake) window.removeEventListener(name, run)
    },
  }
}

function banner() {
  const el = $('div', { class: 'banner', role: 'alert', hidden: true })
  return {
    el,
    show(e) {
      el.textContent = e.message
      el.hidden = false
    },
    clear() {
      el.hidden = true
    },
  }
}

function header(title, sub, { back, actions = [] } = {}) {
  const h1 = $('h1', { text: title })
  const subtitle = $('div', { class: 'sub', text: sub })
  const goBack = () => (inApp ? history.back() : location.replace(back))
  const el = $(
    'header',
    { class: 'top' },
    back && $('button', { class: 'icon-btn back', 'aria-label': 'Back', text: '‹', onclick: goBack }),
    $('div', { class: 'titles' }, h1, subtitle),
    ...actions,
  )
  return {
    el,
    set(t, s) {
      h1.textContent = t
      subtitle.textContent = s
      document.title = t ? `${t} - Treeix` : 'Treeix'
    },
  }
}

const base = (path) => path.split('/').filter(Boolean).pop() ?? path
const dot = (state) => $('span', { class: `dot ${state}` })
const group = (title) => $('div', { class: 'group', text: title })
const empty = (text) => $('div', { class: 'empty', text })
const atBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 48

function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function autoGrow(textarea) {
  textarea.addEventListener('input', () => {
    textarea.style.height = 'auto'
    textarea.style.height = `${textarea.scrollHeight + 2}px`
  })
}

function composer(placeholder, onSend, ...extra) {
  const input = $('textarea', {
    rows: 1,
    placeholder,
    autocapitalize: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    enterkeyhint: 'send',
    'aria-label': placeholder,
  })
  autoGrow(input)
  const send = () => {
    const text = input.value
    input.value = ''
    input.style.height = ''
    onSend(text)
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      send()
    }
  })
  const el = $('div', { class: 'composer' }, input, ...extra, $('button', { class: 'btn primary', text: 'Send', onclick: send }))
  return { el, input }
}

// Home: agents and routines

function home(tab) {
  const head = header('Treeix', host)
  const alert = banner()
  const list = $('div', { class: 'list' })
  const badge = $('span', { class: 'badge', hidden: true })
  const tabs = {
    agents: $('button', { class: 'tab', role: 'tab', onclick: () => select('agents') }, 'Agents', badge),
    routines: $('button', { class: 'tab', role: 'tab', text: 'Routines', onclick: () => select('routines') }),
  }
  let data = null

  function select(next) {
    tab = next
    history.replaceState(null, '', `#/${tab}`)
    render()
  }

  async function act(promise) {
    try {
      await promise
      alert.clear()
    } catch (e) {
      alert.show(e)
    }
    poll.soon()
  }

  function render() {
    for (const [name, el] of Object.entries(tabs)) el.setAttribute('aria-selected', String(name === tab))
    if (!data) return
    const needs = agentItems(data).filter((item) => item.state === 'needs').length
    badge.textContent = needs
    badge.hidden = !needs
    list.replaceChildren(...(tab === 'routines' ? routineViews(data, act) : agentViews(data)))
  }

  const poll = poller(
    3000,
    async () => {
      data = await api('/api/state')
      alert.clear()
      render()
    },
    alert.show,
  )
  render()
  app.replaceChildren(head.el, $('nav', { class: 'tabs', role: 'tablist' }, tabs.agents, tabs.routines), alert.el, list)
  return poll
}

function agentItems(data) {
  return [
    ...data.sessions.map((s) => {
      const [state, label] = SESSION_STATUS[s.status] ?? ['idle', s.status]
      return {
        href: `#/s/${s.id}`,
        name: s.title || base(s.cwd) || s.command.join(' '),
        meta: [KIND[s.kind] ?? s.kind, base(s.cwd), label],
        state,
        at: s.created_at,
      }
    }),
    ...data.chats.map((c) => {
      const [state, label] = CHAT_STATUS[c.status] ?? ['idle', c.status]
      return {
        href: `#/c/${c.id}`,
        name: c.title || base(c.cwd),
        meta: [c.agent === 'codex' ? 'Codex chat' : 'Claude chat', base(c.cwd), label],
        state,
        at: c.createdAt,
      }
    }),
  ].sort((a, b) => b.at - a.at)
}

function agentViews(data) {
  const items = agentItems(data)
  if (!items.length) return [empty('Nothing running on the Mac')]
  const groups = [
    ['Needs you', items.filter((i) => i.state === 'needs')],
    ['Working', items.filter((i) => i.state === 'working')],
    ['Others', items.filter((i) => i.state !== 'needs' && i.state !== 'working')],
  ]
  return groups
    .filter(([, rows]) => rows.length)
    .flatMap(([title, rows]) => [
      group(title),
      ...rows.map((item) =>
        $(
          'button',
          { class: 'row', onclick: () => (location.hash = item.href) },
          dot(item.state),
          $(
            'div',
            { class: 'main' },
            $('div', { class: 'name', text: item.name }),
            $('div', { class: 'meta', text: item.meta.filter(Boolean).join(' · ') }),
          ),
          $('span', { class: 'chev', text: '›' }),
        ),
      ),
    ])
}

function trigger(t) {
  if (t.kind === 'schedule') return `Schedule ${t.cron}`
  if (t.kind === 'event') return EVENTS[t.event] ?? t.event
  return 'Webhook'
}

function routineViews(data, act) {
  if (!data.routines.length && !data.runs.length) return [empty('No routines yet. Make one in Treeix on the Mac.')]
  const sessions = new Set(data.sessions.map((s) => s.id))
  const out = [group('Routines')]
  for (const r of data.routines) {
    const toggle = $('button', {
      class: 'switch',
      role: 'switch',
      'aria-checked': String(r.enabled),
      'aria-label': `${r.name} enabled`,
      onclick: () => {
        toggle.setAttribute('aria-checked', String(!r.enabled))
        act(api(`/api/routines/${r.id}/enabled`, { enabled: !r.enabled }))
      },
    })
    const run = $('button', {
      class: 'btn',
      text: 'Run now',
      onclick: () => {
        run.disabled = true
        act(api(`/api/routines/${r.id}/run`, {}))
      },
    })
    out.push(
      $(
        'div',
        { class: 'card' },
        $(
          'div',
          { class: 'head' },
          $(
            'div',
            { class: 'main' },
            $('div', { class: 'name', text: r.name }),
            $('div', { class: 'meta', text: [trigger(r.trigger), r.agent === 'codex' ? 'Codex' : 'Claude'].filter(Boolean).join(' · ') }),
          ),
          toggle,
        ),
        $('div', { class: 'actions' }, run),
      ),
    )
  }
  if (!data.routines.length) out.push(empty('No routines'))
  if (!data.runs.length) return out
  out.push(group('Recent runs'))
  for (const run of data.runs) {
    const live = run.status === 'queued' || run.status === 'running'
    const actions = [
      run.pr?.url.startsWith('https://') &&
        $('a', { class: 'btn', href: run.pr.url, target: '_blank', rel: 'noopener noreferrer', text: `PR #${run.pr.number}` }),
      run.session && sessions.has(run.session) &&
        $('button', { class: 'btn', text: 'Terminal', onclick: () => (location.hash = `#/s/${run.session}`) }),
      live && $('button', { class: 'btn danger', text: 'Cancel', onclick: () => act(api(`/api/runs/${run.id}/cancel`, {})) }),
    ].filter(Boolean)
    const summary = run.error || run.summary
    out.push(
      $(
        'div',
        { class: 'card' },
        $(
          'div',
          { class: 'head' },
          $(
            'div',
            { class: 'main' },
            $('div', { class: 'name', text: run.name }),
            $('div', { class: 'meta', text: [CAUSE[run.cause], run.detail, ago(run.startedAt ?? run.dueAt)].filter(Boolean).join(' · ') }),
          ),
          $('span', { class: `pill ${run.status}`, text: RUN_STATUS[run.status] ?? run.status }),
        ),
        summary && $('div', { class: 'summary', text: summary }),
        actions.length > 0 && $('div', { class: 'actions' }, ...actions),
      ),
    )
  }
  return out
}

// Terminal

function paint(p) {
  if (p == null) return null
  if (typeof p === 'string') return p
  if (p < 16) return `var(--c${p})`
  if (p < 232) {
    const n = p - 16
    const level = (x) => (x ? 55 + x * 40 : 0)
    return `rgb(${level(Math.floor(n / 36))} ${level(Math.floor(n / 6) % 6)} ${level(n % 6)})`
  }
  const gray = 8 + (p - 232) * 10
  return `rgb(${gray} ${gray} ${gray})`
}

function screenLine(spans) {
  const line = $('div', { class: 'ln' })
  if (RULE.test(spans.map(([text]) => text).join(''))) line.classList.add('rule')
  for (const [text, fgPaint, bgPaint, flags] of spans) {
    if (fgPaint == null && bgPaint == null && !flags) {
      line.append(text)
      continue
    }
    let fg = paint(fgPaint)
    let bg = paint(bgPaint)
    if (flags & 8) [fg, bg] = [bg ?? 'var(--term-bg)', fg ?? 'var(--term-fg)']
    const span = $('span', { class: FLAGS.filter(([bit]) => flags & bit).map(([, c]) => c).join(' ') || null, text })
    if (fg) span.style.color = fg
    if (bg) span.style.backgroundColor = bg
    line.append(span)
  }
  return line
}

/** Wrapped, a TUI's empty rows only push the text apart, so a run of them shows as one */
function wrappedLines(lines) {
  const blank = (spans) => spans.every(([text]) => !text.trim())
  return lines.filter((spans, i) => !blank(spans) || (i > 0 && !blank(lines[i - 1])))
}

/** Width of one monospace cell per px of font size */
function cellRatio() {
  const probe = $('span', { class: 'measure', text: '0'.repeat(20) })
  document.body.append(probe)
  const ratio = probe.getBoundingClientRect().width / 2000
  probe.remove()
  return ratio || 0.6
}

function terminal(id) {
  const alert = banner()
  const screen = $('pre', { class: 'screen' })
  const ratio = cellRatio()
  let cols = 80
  let seq = null
  let lines = []
  // Wrapped and readable by default; Fit shrinks the Mac's full width onto the phone, for TUIs that need their layout
  let fitted = localStorage.getItem(FIT_KEY) === '1'

  function fit() {
    const style = getComputedStyle(screen)
    const width = screen.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
    const size = fitted
      ? Math.min(14, Math.max(5, Math.floor((width / (cols * ratio)) * 10) / 10))
      : Number(localStorage.getItem(FONT_KEY)) || 12
    screen.style.fontSize = `${size}px`
    return size
  }
  function draw() {
    const stick = atBottom(screen)
    screen.replaceChildren(...(fitted ? lines : wrappedLines(lines)).map(screenLine))
    fit()
    if (stick) screen.scrollTop = screen.scrollHeight
  }
  function zoom(factor) {
    localStorage.setItem(FONT_KEY, String(Math.min(20, Math.max(8, Math.round(fit() * factor)))))
    draw()
  }
  const smaller = $('button', { class: 'icon-btn', 'aria-label': 'Smaller text', text: 'A-', onclick: () => zoom(0.85) })
  const larger = $('button', { class: 'icon-btn', 'aria-label': 'Larger text', text: 'A+', onclick: () => zoom(1.15) })
  const fitButton = $('button', {
    class: 'icon-btn toggle',
    'aria-label': 'Fit the Mac width',
    text: 'Fit',
    onclick: () => {
      fitted = !fitted
      localStorage.setItem(FIT_KEY, fitted ? '1' : '0')
      mode()
      draw()
    },
  })
  function mode() {
    screen.classList.toggle('wrap', !fitted)
    fitButton.setAttribute('aria-pressed', String(fitted))
    smaller.hidden = larger.hidden = fitted
  }
  mode()
  const head = header('', '', { back: '#/agents', actions: [smaller, larger, fitButton] })

  async function send(text) {
    try {
      await api(`/api/sessions/${id}/input`, { text })
      alert.clear()
    } catch (e) {
      alert.show(e)
    }
    poll.soon()
  }
  // Text and Enter go separately, so a TUI takes the Enter as submit rather than part of a paste
  const input = composer('Type, then send with Enter', async (text) => {
    if (text) {
      await send(text)
      await new Promise((resolve) => setTimeout(resolve, 60))
    }
    send('\r')
  })
  const keys = $('div', { class: 'keys' }, ...KEYS.map(([label, data, name]) => $('button', { class: 'key', text: label, 'aria-label': name, onclick: () => send(data) })))

  const poll = poller(
    1000,
    async () => {
      const r = await api(`/api/sessions/${id}/screen${seq == null ? '' : `?seq=${seq}`}`)
      const [, label] = SESSION_STATUS[r.info.status] ?? ['', r.info.status]
      head.set(r.info.title || base(r.info.cwd), [KIND[r.info.kind], base(r.info.cwd), label].filter(Boolean).join(' · '))
      alert.clear()
      if (!r.lines) return
      const first = seq == null
      seq = r.seq
      cols = r.cols
      lines = r.lines
      draw()
      if (first) screen.scrollTop = screen.scrollHeight
    },
    alert.show,
  )
  const onResize = () => fit()
  window.addEventListener('resize', onResize)
  app.replaceChildren(head.el, alert.el, screen, keys, input.el)
  fit()
  return {
    ...poll,
    stop() {
      poll.stop()
      window.removeEventListener('resize', onResize)
    },
  }
}

// Chat

function chat(id) {
  const head = header('', '', { back: '#/agents' })
  const alert = banner()
  const log = $('div', { class: 'log' })
  const tools = new Map()
  const asks = new Map()
  let last = null
  let plan = null
  let from = 0

  async function act(promise) {
    try {
      await promise
      alert.clear()
    } catch (e) {
      alert.show(e)
    }
    poll.soon()
  }

  const stop = $('button', { class: 'btn danger', text: 'Stop', hidden: true, onclick: () => act(api(`/api/chats/${id}/cancel`, {})) })
  const input = composer('Message', (text) => text.trim() && act(api(`/api/chats/${id}/prompt`, { text })), stop)

  function toolRow(call) {
    const status = dot('idle')
    const title = $('span', { class: 'title' })
    const patch = (p) => {
      if (p.title != null) title.textContent = p.title
      if (p.status) status.className = `dot ${TOOL_STATUS[p.status] ?? 'idle'}`
    }
    patch(call)
    return { el: $('div', { class: 'tool' }, status, title), patch }
  }

  function ask(e) {
    const buttons = e.options.map((option) =>
      $('button', {
        class: option.kind === 'allow_once' ? 'btn primary' : 'btn',
        text: option.name,
        onclick: () => {
          for (const b of buttons) b.disabled = true
          act(api(`/api/chats/${id}/answer`, { request: e.requestId, option: option.id }))
        },
      }),
    )
    const card = $('div', { class: 'ask' }, $('div', { class: 'q', text: e.title }), $('div', { class: 'actions' }, ...buttons))
    return {
      el: card,
      settle() {
        card.classList.add('settled')
        for (const b of buttons) b.disabled = true
      },
    }
  }

  function add({ event: e }) {
    // A subagent's own messages and tools stay on the Mac
    if (e.parent) return
    switch (e.type) {
      case 'message_chunk': {
        if (last?.role !== e.role) {
          last = { role: e.role, el: $('div', { class: `msg ${e.role}` }) }
          log.append(last.el)
        }
        last.el.append(e.content.type === 'text' ? e.content.text : '[image]')
        return
      }
      case 'tool_call': {
        last = null
        const row = toolRow(e.call)
        tools.set(e.call.id, row)
        log.append(row.el)
        return
      }
      case 'tool_call_update':
        tools.get(e.id)?.patch(e.patch)
        return
      case 'plan': {
        last = null
        plan ??= $('div', { class: 'plan' })
        const marks = { completed: '✓ ', in_progress: '› ', pending: '· ' }
        plan.replaceChildren($('div', { class: 'plan-title', text: 'Plan' }), ...e.entries.map((entry) => $('div', { class: entry.status, text: (marks[entry.status] ?? '') + entry.content })))
        log.append(plan)
        return
      }
      case 'permission': {
        last = null
        const card = ask(e)
        asks.set(e.requestId, card)
        log.append(card.el)
        return
      }
      case 'permission_settled':
        asks.get(e.requestId)?.settle()
        return
      case 'turn_start':
      case 'turn_end':
        last = null
        return
      case 'error':
      case 'disconnected':
        last = null
        log.append($('div', { class: 'note', text: e.message }))
        return
    }
  }

  const poll = poller(
    1000,
    async () => {
      const r = await api(`/api/chats/${id}/log?from=${from}`)
      const [, label] = CHAT_STATUS[r.info.status] ?? ['', r.info.status]
      head.set(r.info.title || base(r.info.cwd), [r.info.agent === 'codex' ? 'Codex' : 'Claude', base(r.info.cwd), label].join(' · '))
      stop.hidden = r.info.status !== 'running'
      alert.clear()
      if (!r.entries.length) return
      const stick = from === 0 || atBottom(log)
      for (const entry of r.entries) add(entry)
      from = r.entries[r.entries.length - 1].seq + 1
      if (stick) log.scrollTop = log.scrollHeight
    },
    alert.show,
  )
  app.replaceChildren(head.el, alert.el, log, input.el)
  return poll
}

// Routing

function route() {
  current?.stop()
  document.title = 'Treeix'
  const [page, id] = location.hash.replace(/^#\/?/, '').split('/')
  const fixed = (page === 's' || page === 'c') && Boolean(id)
  app.classList.toggle('view-fixed', fixed)
  fitViewport()
  window.scrollTo(0, 0)
  if (page === 's' && id) current = terminal(decodeURIComponent(id))
  else if (page === 'c' && id) current = chat(decodeURIComponent(id))
  else current = home(page === 'routines' ? 'routines' : 'agents')
}

/** Terminal and chat fill what the keyboard leaves visible */
function fitViewport() {
  const viewport = window.visualViewport
  app.style.height = app.classList.contains('view-fixed') && viewport ? `${viewport.height}px` : ''
}

window.visualViewport?.addEventListener('resize', fitViewport)
window.addEventListener('hashchange', () => {
  inApp = true
  route()
})
route()
