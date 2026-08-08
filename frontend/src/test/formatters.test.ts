import { describe, it, expect } from 'vitest'
import { fmtCount, fmtDate } from '../lib/formatters'

describe('fmtCount', () => {
  it('formats thousands', () => expect(fmtCount(1500)).toBe('1.5K'))
  it('formats millions', () => expect(fmtCount(2_500_000)).toBe('2.5M'))
  it('formats small', () => expect(fmtCount(42)).toBe('42'))
  it('handles null', () => expect(fmtCount(null)).toBe('—'))
})

describe('fmtDate', () => {
  it('formats ISO date', () => {
    const result = fmtDate('2024-03-15T00:00:00Z')
    expect(result).toContain('2024')
  })
  it('handles null', () => expect(fmtDate(null)).toBe('—'))
})
