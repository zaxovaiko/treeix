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

export async function createPortalSession(account: Account): Promise<string> {
  const session = await stripe.billingPortal.sessions.create({
    customer: account.stripeCustomerId,
    return_url: 'https://orbit.dev/settings'
  })
  return session.url
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
import { stripe } from '../lib/stripe'
import type { Account } from '../auth/session'

export type Invoice = { id: string; total: number; paidAt: Date | null }

export async function createPortalSession(account: Account, returnPath = '/settings/billing'): Promise<string> {
  const session = await stripe.billingPortal.sessions.create({
    customer: account.stripeCustomerId,
    return_url: new URL(returnPath, 'https://orbit.dev').toString()
  })
  return session.url
}

export async function listInvoices(account: Account, limit = 12): Promise<Invoice[]> {
  const { data } = await stripe.invoices.list({ customer: account.stripeCustomerId, limit })
  return data.map((invoice) => ({
    id: invoice.id,
    total: invoice.total / 100,
    paidAt: invoice.status_transitions.paid_at ? new Date(invoice.status_transitions.paid_at * 1000) : null
  }))
}
EOF
cat > src/billing/invoices.test.ts <<'EOF'
import { expect, test } from 'bun:test'
import { listInvoices } from './portal'

test('converts cents and unpaid invoices', async () => {
  const invoices = await listInvoices({ id: 'acc_1', email: 'ada@orbit.dev', stripeCustomerId: 'cus_demo' })
  expect(invoices[0]).toEqual({ id: 'in_1', total: 49, paidAt: null })
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
