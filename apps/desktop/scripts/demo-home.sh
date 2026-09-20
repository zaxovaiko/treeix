#!/bin/sh
# Fake home with demo repos, worktrees and agent edits, for store and landing screenshots.
# Usage: sh scripts/demo-home.sh /tmp/treeix-demo && HOME=/tmp/treeix-demo dist/mac-arm64/Treeix.app/Contents/MacOS/Treeix
set -e
home=${1:?demo home path}
rm -rf "$home" && mkdir -p "$home/code" "$home/.claude/plans"
export HOME="$home" GIT_CONFIG_NOSYSTEM=1
git config --global user.name "Ada Park" && git config --global user.email ada@orbit.dev && git config --global init.defaultBranch main

repo=$home/code/orbit-web
mkdir -p "$repo/src/billing" "$repo/src/auth" && cd "$repo" && git init -q
cat > src/billing/portal.ts <<'EOF'
import { stripe } from '../lib/stripe'
import type { Account } from '../auth/session'

const RETURN_URL = 'https://orbit.dev/account'

export async function portalSession(account: Account) {
  const { billingPortal } = stripe
  const session = await billingPortal.sessions.create({
    customer: account.stripeCustomerId,
    return_url: RETURN_URL
  })
  return session.url
}

export async function currentPlan(account: Account) {
  const plan = await stripe.subscriptions.retrieve(
    account.subscriptionId
  )
  return plan.items.data[0].price.nickname
}

export function billingEmail(account: Account) {
  return account.billingEmail ?? account.email
}
EOF
cat > src/auth/session.ts <<'EOF'
export type Account = { id: string; email: string; stripeCustomerId: string }

const SESSION_TTL_MS = 60 * 60 * 1000

export function isExpired(issuedAt: number, now = Date.now()): boolean {
  return now - issuedAt > SESSION_TTL_MS
}
EOF
printf '# Orbit web\n\nCustomer dashboard for Orbit.\n' > README.md
git add -A && git commit -qm "feat: billing portal and sessions"

git worktree add -q -b feat/usage-invoices .claude/worktrees/feat+usage-invoices
cd .claude/worktrees/feat+usage-invoices
cat > src/billing/portal.ts <<'EOF'
import type Stripe from 'stripe'
import { stripe } from '../lib/stripe'
import type { Account } from '../auth/session'

const RETURN_URL = 'https://orbit.dev/billing'

export type Invoice = {
  id: string
  total: number
  paidAt: Date | null
}

export async function portalSession(account: Account) {
  const { billingPortal } = stripe
  const session = await billingPortal.sessions.create({
    customer: account.stripeCustomerId,
    return_url: RETURN_URL
  })
  return session.url
}

export async function listInvoices(account: Account) {
  const { data } = await stripe.invoices.list({
    customer: account.stripeCustomerId,
    limit: 12
  })
  return data.map(toInvoice)
}

function toInvoice(invoice: Stripe.Invoice): Invoice {
  const paid = invoice.status_transitions.paid_at
  return {
    id: invoice.id,
    total: invoice.total / 100,
    paidAt: paid ? new Date(paid * 1000) : null
  }
}

export async function currentPlan(account: Account) {
  const plan = await stripe.subscriptions.retrieve(
    account.subscriptionId
  )
  return plan.items.data[0].price.nickname
}

export function billingEmail(account: Account) {
  return account.billingEmail ?? account.email
}
EOF
cat > src/billing/invoices.test.ts <<'EOF'
import { expect, test } from 'bun:test'
import { listInvoices } from './portal'

const account = {
  id: 'acc_1',
  email: 'ada@orbit.dev',
  stripeCustomerId: 'cus_demo'
}

test('converts cents and keeps unpaid invoices', async () => {
  const invoices = await listInvoices(account)
  expect(invoices[0].total).toBe(49)
  expect(invoices[0].paidAt).toBeNull()
})
EOF

cd "$repo" && git worktree add -q -b fix/session-timeout .claude/worktrees/fix+session-timeout
cd .claude/worktrees/fix+session-timeout
cat > src/auth/session.ts <<'EOF'
export type Account = { id: string; email: string; stripeCustomerId: string }

const SESSION_TTL_MS = 12 * 60 * 60 * 1000
const CLOCK_SKEW_MS = 30 * 1000

export function isExpired(issuedAt: number, now = Date.now()): boolean {
  return now - issuedAt > SESSION_TTL_MS + CLOCK_SKEW_MS
}
EOF

api=$home/code/orbit-api
mkdir -p "$api/internal/ratelimit" && cd "$api" && git init -q
cat > internal/ratelimit/limiter.go <<'EOF'
package ratelimit

import "time"

type Limiter struct {
	perMinute int
	hits      map[string][]time.Time
}

func New(perMinute int) *Limiter {
	return &Limiter{perMinute: perMinute, hits: map[string][]time.Time{}}
}
EOF
git add -A && git commit -qm "feat: rate limiter skeleton"
cat >> internal/ratelimit/limiter.go <<'EOF'

func (l *Limiter) Allow(key string, now time.Time) bool {
	window := now.Add(-time.Minute)
	recent := l.hits[key][:0]
	for _, hit := range l.hits[key] {
		if hit.After(window) {
			recent = append(recent, hit)
		}
	}
	if len(recent) >= l.perMinute {
		l.hits[key] = recent
		return false
	}
	l.hits[key] = append(recent, now)
	return true
}
EOF

mkdir -p "$home/code/design-tokens" && cd "$home/code/design-tokens" && git init -q && printf '{ "radius": 8 }\n' > tokens.json && git add -A && git commit -qm "chore: init"

cat > "$home/.claude/plans/usage-invoices.md" <<'EOF'
# Show usage invoices in billing settings

1. Add `listInvoices` next to the portal session helper
2. Render the last 12 invoices with paid state
3. Cover cents conversion and unpaid invoices with a test
EOF

# --- v3 screenshot fixtures: fake claude and codex on PATH, and a login shell with a stable prompt ---
mkdir -p "$home/bin" "$home/.claude/projects/demo"
printf 'export PATH="$HOME/bin:$PATH"\nexport PS1="%%1~ %%# "\nunset RPS1 RPROMPT\n' > "$home/.zprofile"
cp "$home/.zprofile" "$home/.zshrc"

cat > "$home/bin/claude" <<'EOF'
#!/bin/sh
# Stands in for Claude Code in screenshots: same shape of output, no network, never exits.
printf '\033[2J\033[H\033]2;Billing invoices\007'
printf '\033[38;5;209m✳\033[0m Read \033[1msrc/billing/portal.ts\033[0m (34 lines)\n'
printf '  \033[2m⎿ portalSession, currentPlan, billingEmail\033[0m\n\n'
printf '\033[38;5;209m✳\033[0m Wrote plan to ~/.claude/plans/usage-invoices.md\n'
printf '  \033[2m⎿ 3 steps: list, render, cover with a test\033[0m\n\n'
printf '\033[38;5;209m✳\033[0m Wrote \033[1msrc/billing/portal.ts\033[0m\n'
printf '  \033[2m⎿ +24 −1  listInvoices maps cents to units\033[0m\n\n'
printf '\033[38;5;209m✳\033[0m Wrote \033[1msrc/billing/invoices.test.ts\033[0m\n'
printf '  \033[2m⎿ +14  unpaid invoices keep a null paid date\033[0m\n\n'
printf '\033[38;5;209m✳\033[0m Both files compile. The test needs the bun runner.\n\n'
printf '\033[1mRun bun test src/billing? \033[0m\n'
printf '\033[36m❯ 1. Yes\033[0m\n'
printf '  2. Yes, and don'"'"'t ask again for bun test\n'
printf '  3. No, tell Claude what to do differently\n\n'
while :; do read -r _ 2>/dev/null || sleep 3600; done
EOF

cat > "$home/bin/codex" <<'EOF'
#!/bin/sh
printf '\033[2J\033[H\033]2;Session timeout\007'
printf '\033[38;5;39m◎\033[0m codex \033[2m/ gpt-5-codex\033[0m\n\n'
printf '  Read src/auth/session.ts\n'
printf '  Edited src/auth/session.ts +2 -1\n'
printf '    \033[2mSESSION_TTL_MS 12h, 30s clock skew\033[0m\n\n'
printf '\033[2mIdle. Type a message, or press Esc twice to interrupt.\033[0m\n\n'
while :; do read -r _ 2>/dev/null || sleep 3600; done
EOF
chmod +x "$home/bin/claude" "$home/bin/codex"
