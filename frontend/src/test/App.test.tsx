import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import App from '../App'

globalThis.fetch = vi.fn().mockResolvedValue({
  ok: true,
  json: async () => ({ nodes: [], edges: [], node_count: 0, edge_count: 0, filters: {} }),
}) as any

describe('App', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('renders header', () => {
    render(<App />)
    expect(screen.getByText('InstaRL')).toBeInTheDocument()
  })

  it('renders tabs', () => {
    render(<App />)
    expect(screen.getByText('Graph')).toBeInTheDocument()
    expect(screen.getByText('Scans')).toBeInTheDocument()
  })

  it('shows empty state with no data', async () => {
    render(<App />)
    expect(await screen.findByText(/No data yet/)).toBeInTheDocument()
  })
})
