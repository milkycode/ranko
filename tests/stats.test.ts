import { describe, expect, test } from 'claude-code/testing'

import { cacheColor, cacheOf, fillColor, limitsOf, logChunks, planLimits, span, summaryOf, tokens } from '../hooks/stats'

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
    expect(limitsOf([{ kind: 'spend_limit', percentUsed: 7.5 }], 0)).toEqual({ percent: 7.5, text: 'spend 8%' })

    const fiveHours = '2030-01-07T17:40:00Z'
    const limits = [
      { kind: 'seven_day', percentUsed: 41, resetsAt: '2030-01-13T09:00:00Z' },
      { kind: 'five_hour', percentUsed: 23, resetsAt: fiveHours },
    ]
    const shown = limitsOf(limits, Date.parse(fiveHours) - 2 * 3_600_000)
    expect(shown?.percent).toBe(23)
    expect(shown?.text).toMatch(/^7d 41% ↻ \w{3} \d\d:\d\d · 5h 23% ↻ \d\d:\d\d$/)
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
