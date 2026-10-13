import { describe, expect, it } from 'bun:test'
import { DEFAULT_RULES } from '../shared/types'
import { type Call, type DetectorState, detect, needsTabs, step } from './detector'

const CHROME = 'com.google.Chrome.helper'
const meet = { url: 'https://meet.google.com/abc-defg-hij?authuser=0', title: 'Meet - Daily' }
const delays = { startMs: 3_000, stopMs: 20_000 }

describe('detect', () => {
  it('matches a Meet tab while Chrome holds the microphone', () => {
    expect(detect(DEFAULT_RULES, [CHROME], [{ url: 'https://example.com', title: '' }, meet])).toEqual({
      name: 'Google Meet',
      app: 'com.google.Chrome',
      url: meet.url,
      key: 'com.google.Chrome https://meet.google.com/abc-defg-hij'
    })
  })

  it('ignores a Meet tab when Chrome is off the microphone, and the Meet landing page', () => {
    expect(detect(DEFAULT_RULES, [], [meet])).toBeNull()
    expect(detect(DEFAULT_RULES, [CHROME], [{ url: 'https://meet.google.com/landing', title: '' }])).toBeNull()
  })

  it('matches an app rule without tabs', () => {
    expect(detect(DEFAULT_RULES, ['com.tinyspeck.slackmacgap.helper'], [])?.name).toBe('Slack huddle')
  })

  it('reads tabs only when a URL rule app holds the microphone', () => {
    expect(needsTabs(DEFAULT_RULES, ['us.zoom.xos'])).toBe(false)
    expect(needsTabs(DEFAULT_RULES, [CHROME])).toBe(true)
  })

  it('skips a rule with a broken pattern', () => {
    expect(detect([{ name: 'Broken', app: 'com.google.Chrome', url: '(' }], [CHROME], [meet])).toBeNull()
  })
})

describe('step', () => {
  const call: Call = { name: 'Zoom', app: 'us.zoom.xos', url: null, key: 'us.zoom.xos' }
  const other: Call = { ...call, key: 'other' }
  const run = (states: [Call | null, number][]): (string | null)[] => {
    let state: DetectorState = { state: 'idle' }
    return states.map(([seen, now]) => {
      const { next, action } = step(state, seen, now, delays)
      state = next
      return action
    })
  }

  it('starts after the start delay and stops after the stop delay', () => {
    expect(
      run([
        [call, 0],
        [call, 2_000],
        [call, 3_000],
        [null, 4_000],
        [null, 22_000],
        [null, 23_000]
      ])
    ).toEqual([null, null, 'start', null, null, 'stop'])
  })

  it('a call that comes back within the stop delay keeps recording', () => {
    expect(
      run([
        [call, 0],
        [call, 3_000],
        [null, 10_000],
        [call, 25_000],
        [null, 30_000],
        [null, 44_000]
      ])
    ).toEqual([null, 'start', null, null, null, null])
  })

  it('switching calls while waiting restarts the wait', () => {
    expect(
      run([
        [call, 0],
        [other, 2_000],
        [other, 4_000],
        [other, 5_000]
      ])
    ).toEqual([null, null, null, 'start'])
  })

  it('a dismissed call stays dismissed until it is gone', () => {
    const dismissed: DetectorState = { state: 'dismissed' }
    expect(step(dismissed, call, 0, delays).next).toEqual(dismissed)
    expect(step(dismissed, null, 0, delays).next).toEqual({ state: 'idle' })
  })
})
