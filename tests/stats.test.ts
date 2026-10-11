import { describe, expect, test } from 'claude-code/testing'

import { cacheText, limitsText, logChunks, span, summaryOf, tokens } from '../hooks/stats'

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

  test('the cache is warm for its stretch after a request, then expired', () => {
    const reading = { at: 0, input: 0, read: 0, written: 0 }
    expect(cacheText(null, 300_000, 0)).toBe('no request yet')
    expect(cacheText(reading, 300_000, 60_000)).toBe('warm · 4m left')
    expect(cacheText(reading, 300_000, 420_000)).toBe('expired 2m ago')
  })

  test('limits name their window and reset; none, no line', () => {
    expect(limitsText([], 0)).toBeNull()
    expect(limitsText([{ kind: 'spend_limit', percentUsed: 7.5 }], 0)).toBe('spend 8%')
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
