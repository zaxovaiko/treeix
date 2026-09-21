/** One element on the way from the target up to <body>: its tag, id, and place among same-tag siblings */
export type Step = { tag: string; id: string; nth: number; sameTagSiblings: number }

const plainId = /^[A-Za-z][\w-]*$/

/** The shortest `a > b > c` path, from the target up, that matches only the target */
export function selectorFor(steps: Step[], isUnique: (selector: string) => boolean): string {
  const parts: string[] = []
  for (const step of steps) {
    parts.unshift(step.id && plainId.test(step.id) ? `#${step.id}` : step.sameTagSiblings > 1 ? `${step.tag}:nth-of-type(${step.nth})` : step.tag)
    const selector = parts.join(' > ')
    if (isUnique(selector)) return selector
  }
  return parts.join(' > ')
}
