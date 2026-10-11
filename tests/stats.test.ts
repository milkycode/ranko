import { describe, expect, test } from 'claude-code/testing'

import {
  cacheColor,
  cacheOf,
  contextOf,
  fillColor,
  fullAt,
  isNearlyFull,
  isSameReset,
  limitsOf,
  logChunks,
  nextTasks,
  planLimits,
  span,
  summaryOf,
  tasksOf,
  tokens,
} from '../hooks/stats'
import type { Task } from '../hooks/stats'

const HOUR = 3_600_000

describe('stats', () => {
  test('token counts and spans read short', () => {
    expect(tokens(950)).toBe('950')
    expect(tokens(84_400)).toBe('84k')
    expect(tokens(1_000_000)).toBe('1M')
    expect(tokens(1_250_000)).toBe('1.3M')
    expect(span(30_000)).toBe('<1m')
    expect(span(47 * 60_000 + 59_000)).toBe('47m')
    expect(span(90 * 60_000)).toBe('1h 30m')
  })

  test('the cache is warm for its stretch after a request, its bar running down, then expired', () => {
    const reading = { at: 0, input: 100, read: 9000, written: 900 }
    expect(cacheOf(null, 300_000, 0)).toEqual({ percent: 0, text: 'no request yet' })
    expect(cacheOf(reading, 300_000, 60_000)).toEqual({ percent: 80, text: '4m left · 90% read' })
    expect(cacheOf(reading, 300_000, 270_000)).toEqual({ percent: 10, text: '<1m left · 90% read' })
    expect(cacheOf(reading, 300_000, 420_000)).toEqual({ percent: 0, text: 'expired 2m ago' })
  })

  test('bars turn yellow, then red: a used-up share as it fills, the cache as its time runs out', () => {
    expect([10, 50, 79, 80].map(fillColor)).toEqual(['success', 'warning', 'warning', 'error'])
    expect([100, 50, 49, 25, 24].map(cacheColor)).toEqual(['success', 'success', 'warning', 'warning', 'error'])
  })

  test('limits name their window and its reset after a mark; the bar is the session window', () => {
    expect(limitsOf([], 0)).toBeNull()
    expect(limitsOf([{ kind: 'spend_limit', percentUsed: 7.5 }], 0)).toEqual({
      percent: 7.5,
      isRunningOut: false,
      text: 'spend 8%',
    })

    const fiveHours = '2030-01-07T17:40:00Z'
    const limits = [
      { kind: 'seven_day', percentUsed: 41, resetsAt: '2030-01-13T09:00:00Z' },
      { kind: 'five_hour', percentUsed: 23, resetsAt: fiveHours },
    ]
    // Three hours into the five: 23% at that pace lasts; a day and a half
    // into the week, 41% runs full well before it resets.
    const shown = limitsOf(limits, Date.parse(fiveHours) - 2 * HOUR)
    expect(shown?.percent).toBe(23)
    expect(shown?.isRunningOut).toBe(false)
    expect(shown?.text).toMatch(/^7d 41% ↻ \w{3} \d\d:\d\d \(full ≈ \w{3} \d\d:\d\d\) · 5h 23% ↻ \d\d:\d\d \(lasts\)$/)
  })

  test('a limit runs full at its recent pace, else at its window so far', () => {
    const reset = Date.parse('2030-01-07T17:00:00Z')
    const limit = { kind: 'five_hour', percentUsed: 50, resetsAt: '2030-01-07T17:00:00.152366+00:00' }
    // Three and a half hours into the window, 50% used: at that pace the
    // rest takes as long again, past the reset an hour and a half away.
    const now = reset - 1.5 * HOUR
    expect(fullAt(limit, now)).toBe('lasts')
    // But the last twenty minutes went from 30% to 50%, a point a minute:
    // full in fifty minutes, before the reset.
    const samples = [
      { at: now - 20 * 60_000, percent: 30 },
      { at: now, percent: 50 },
    ]
    expect(fullAt(limit, now, samples)).toBe(now + 50 * 60_000)
    // Readings five minutes apart are too few: the window's pace stands.
    expect(fullAt(limit, now, samples.map((s, i) => (i === 0 ? { ...s, at: now - 5 * 60_000 } : s)))).toBe('lasts')
    // Nothing used lately: it lasts.
    expect(fullAt(limit, now, [{ at: now - 20 * 60_000, percent: 50 }, { at: now, percent: 50 }])).toBe('lasts')
    // Five minutes into a window, or already full: nothing to tell.
    expect(fullAt(limit, reset - 5 * HOUR + 5 * 60_000)).toBeNull()
    expect(fullAt({ ...limit, percentUsed: 100 }, now)).toBeNull()

    const running = limitsOf([limit], now, samples)
    expect(running?.isRunningOut).toBe(true)
    expect(running?.text).toMatch(/^5h 50% ↻ \d\d:\d\d \(full ≈ \d\d:\d\d\)$/)
  })

  test("a reset time read again, stamped to another microsecond, is the same window's", () => {
    expect(isSameReset('2030-01-07T17:00:00.152366+00:00', '2030-01-07T17:00:00.152389+00:00')).toBe(true)
    expect(isSameReset('2030-01-07T17:00:00+00:00', '2030-01-07T22:00:00+00:00')).toBe(false)
    expect(isSameReset(undefined, '2030-01-07T17:00:00+00:00')).toBe(false)
  })

  test('the context says how far auto-compaction is, and when compacting is due', () => {
    const usage = { startedAt: 0, rateLimits: [], context: { window: 200_000, percent: 72, tokens: 144_000 } }
    const context = contextOf(usage, 167_000)
    expect(context?.text).toBe('72% · 144k / 200k · auto-compact in 23k')
    expect(contextOf(usage, 140_000)?.text).toBe('72% · 144k / 200k · auto-compact due')
    expect(contextOf(usage)?.text).toBe('72% · 144k / 200k')
    // Due within the last tenth before auto-compaction; without it, from 80%.
    expect(isNearlyFull({ percent: 72, left: 23_000 }, 167_000)).toBe(false)
    expect(isNearlyFull({ percent: 72, left: 16_000 }, 167_000)).toBe(true)
    expect(isNearlyFull({ percent: 80, left: null }, null)).toBe(true)
  })

  test('the task list follows TodoWrite and the Task tools', () => {
    const todos = nextTasks([], 'TodoWrite', {
      todos: [
        { content: 'Write tests', status: 'completed', activeForm: 'Writing tests' },
        { content: 'Fix the bug', status: 'in_progress', activeForm: 'Fixing the bug' },
        { content: 'Ship it', status: 'pending', activeForm: 'Shipping it' },
      ],
    }, {})
    expect(tasksOf(todos, true)).toEqual({ percent: (1 / 3) * 100, text: '1/3 · Fixing the bug' })

    let tasks: Task[] = []
    tasks = nextTasks(tasks, 'TaskCreate', { subject: 'Read the code', description: '', activeForm: 'Reading the code' }, { task: { id: '1', subject: 'Read the code' } })
    tasks = nextTasks(tasks, 'TaskCreate', { subject: 'Draft a plan', description: '' }, { task: { id: '2', subject: 'Draft a plan' } })
    tasks = nextTasks(tasks, 'TaskCreate', { subject: 'Drop me', description: '' }, { task: { id: '3', subject: 'Drop me' } })
    tasks = nextTasks(tasks, 'TaskUpdate', { taskId: '1', status: 'in_progress' }, { success: true })
    expect(tasksOf(tasks, true)?.text).toBe('0/3 · Reading the code')
    tasks = nextTasks(tasks, 'TaskUpdate', { taskId: '3', status: 'deleted' }, { success: true })
    tasks = nextTasks(tasks, 'TaskUpdate', { taskId: '1', status: 'completed' }, { success: true })
    tasks = nextTasks(tasks, 'TaskUpdate', { taskId: '2', status: 'in_progress' }, { success: true })
    expect(tasksOf(tasks, true)?.text).toBe('1/2 · Draft a plan')

    // TaskList reads it back, the active forms kept.
    tasks = nextTasks(tasks, 'TaskList', {}, {
      tasks: [
        { id: '1', subject: 'Read the code', status: 'completed', blockedBy: [] },
        { id: '2', subject: 'Draft a plan', status: 'completed', blockedBy: [] },
      ],
    })
    expect(tasks[0]?.activeForm).toBe('Reading the code')
    // All done: shown while the turn runs, gone after it.
    expect(tasksOf(tasks, true)?.text).toBe('2/2 · all done')
    expect(tasksOf(tasks, false)).toBeNull()
    expect(tasksOf([], true)).toBeNull()
  })

  test("the usage endpoint's windows become limits; a body without them, none", () => {
    const body = JSON.stringify({
      five_hour: { utilization: 68.0, resets_at: '2030-01-07T16:40:00+00:00' },
      seven_day: { utilization: 62.0, resets_at: '2030-01-12T10:00:00+00:00' },
      seven_day_opus: null,
    })
    expect(planLimits(body)).toEqual([
      { kind: 'five_hour', percentUsed: 68, resetsAt: '2030-01-07T16:40:00+00:00' },
      { kind: 'seven_day', percentUsed: 62, resetsAt: '2030-01-12T10:00:00+00:00' },
    ])
    expect(planLimits('{"five_hour":null}')).toBeNull()
    expect(planLimits('not json')).toBeNull()
  })

  test('a long text is cut between paragraphs, and inside one only when it must be', () => {
    const paragraph = (n: number) => `${'x'.repeat(n - 1)}.`
    expect(logChunks(`${paragraph(1500)}\n\n${paragraph(1500)}`, 2000)).toEqual([paragraph(1500), paragraph(1500)])
    expect(logChunks(`${paragraph(500)}\n\n${paragraph(500)}`, 2000)).toEqual([`${paragraph(500)}\n\n${paragraph(500)}`])

    // One paragraph of sentences longer than a line: cut between sentences.
    const sentences = Array.from({ length: 30 }, (_, i) => `Sentence ${i} ${'y'.repeat(90)}.`).join(' ')
    const chunks = logChunks(sentences, 2000)
    expect(chunks.length).toBe(2)
    expect(chunks.every(c => c.length <= 2000 && c.endsWith('.'))).toBe(true)
    expect(chunks.join(' ')).toBe(sentences)

    // No break at all: cut where the line is full.
    expect(logChunks('z'.repeat(4500), 2000).map(c => c.length)).toEqual([2000, 2000, 500])
  })

  test('the summary is the message the compaction did not keep', () => {
    const kept = { role: 'user' as const, text: 'kept', toolUses: [], handle: 'h1' }
    const summary = { role: 'user' as const, text: 'the summary', toolUses: [] }
    expect(summaryOf([kept], [summary, kept])).toBe('the summary')
    expect(summaryOf([kept], [kept])).toBeNull()
  })
})
