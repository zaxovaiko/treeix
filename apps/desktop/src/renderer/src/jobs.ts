import type { IconName } from './Icon'

/** Starters on Home that fill the composer with a prompt for a common job */
export const JOBS: { icon: IconName; label: string; prompt: string }[] = [
  {
    icon: 'alert',
    label: 'Bug Reproduction',
    prompt: 'Reproduce this bug end to end before changing any code, then fix its root cause and add a test that fails without the fix:\n\n'
  },
  { icon: 'refresh', label: 'Fix CI', prompt: 'CI fails on this branch. Find the failing job, reproduce it locally, fix the cause, and run the CI commands until they pass.' },
  {
    icon: 'pullRequest',
    label: 'Review PRs',
    prompt: 'Review the open pull requests in this repo: for each, what it changes, the bugs and risks you find with file and line, and whether it is ready to merge.'
  },
  {
    icon: 'tag',
    label: 'Release Manager',
    prompt: 'Prepare the next release: list the changes since the last tag, draft the release notes, and tell me what is left before it can ship.'
  },
  {
    icon: 'layers',
    label: 'Dependency Updates',
    prompt: 'Find outdated dependencies, update the safe ones, run the tests, and list the major updates that need my decision with what breaks.'
  }
]
