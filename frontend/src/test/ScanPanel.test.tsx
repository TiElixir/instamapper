import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ScanPanel from '../components/ScanPanel'
import { api } from '../api/client'

vi.mock('../api/client', () => ({
  api: {
    listScans: vi.fn(),
    getScan: vi.fn(),
    createExtensionScan: vi.fn(),
    deleteScan: vi.fn(),
    clearAllData: vi.fn(),
  },
}))

describe('ScanPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.listScans).mockResolvedValue([])
    vi.mocked(api.getScan).mockResolvedValue({} as never)
    vi.mocked(api.createExtensionScan).mockResolvedValue({
      scan_id: 1,
      status: 'running',
      target: 'alice',
      depth: 2,
    })
  })

  it('starts an extension scan', async () => {
    vi.mocked(api.createExtensionScan).mockResolvedValue({
      scan_id: 1,
      status: 'running',
      target: 'alice',
      depth: 2,
    })
    render(<ScanPanel />)
    fireEvent.change(screen.getByPlaceholderText('Username'), { target: { value: 'alice' } })
    fireEvent.change(screen.getByPlaceholderText('Depth (1-3)'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start Extension Scan' }))
    await waitFor(() => expect(api.createExtensionScan).toHaveBeenCalledWith({ target: 'alice', depth: 2 }))
  })
})
