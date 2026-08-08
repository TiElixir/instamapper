import { useCallback, useEffect, useState } from 'react'
import { api, ScanDetail, ScanSummary, ScanStatus } from '../api/client'
import { fmtRelative } from '../lib/formatters'

interface Props {
  onScanComplete?: () => void
}

const STATUS_ICON: Record<ScanStatus, string> = {
  pending: '⏳',
  running: '🔄',
  completed: '✅',
  failed: '❌',
  cancelled: '🚫',
}

function isActiveScan(status: ScanStatus) {
  return status === 'running' || status === 'pending'
}

export default function ScanPanel({ onScanComplete }: Props) {
  const [scans, setScans] = useState<ScanSummary[]>([])
  const [target, setTarget] = useState('')
  const [depth, setDepth] = useState(1)
  const [creating, setCreating] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [scanDetails, setScanDetails] = useState<Record<number, ScanDetail>>({})

  const loadScans = useCallback(async () => {
    try { setScans(await api.listScans()) } catch {}
  }, [])

  useEffect(() => {
    loadScans()
    const iv = setInterval(loadScans, 5000)
    return () => clearInterval(iv)
  }, [loadScans])

  const handleCreate = async () => {
    if (!target.trim()) return
    setCreating(true)
    try {
      await api.createExtensionScan({ target: target.trim(), depth })
      setTarget('')
      loadScans()
    } catch {} finally {
      setCreating(false)
    }
  }

  const handleDelete = async (id: number) => {
    try {
      await api.deleteScan(id)
      setScanDetails(details => {
        const next = { ...details }
        delete next[id]
        return next
      })
      loadScans()
    } catch {}
  }

  const toggleScanErrors = async (scan: ScanSummary) => {
    if (scanDetails[scan.id]) {
      setScanDetails(details => {
        const next = { ...details }
        delete next[scan.id]
        return next
      })
      return
    }
    try {
      const detail = await api.getScan(scan.id)
      setScanDetails(details => ({ ...details, [scan.id]: detail }))
    } catch {}
  }

  const handleClearAll = async () => {
    if (!window.confirm('Delete ALL scan data, users, and edges? This cannot be undone.')) return
    setClearing(true)
    try {
      await api.clearAllData()
      setScans([])
      onScanComplete?.()
    } catch {} finally {
      setClearing(false)
    }
  }

  useEffect(() => {
    const running = scans.filter(s => s.status === 'running' || s.status === 'pending')
    if (running.length === 0 && scans.some(s => s.status === 'completed')) {
      onScanComplete?.()
    }
  }, [scans])

  return (
    <div className="scan-panel">
      <h2>New Scan</h2>
      <div className="scan-form">
        <input placeholder="Username" value={target} onChange={e => setTarget(e.target.value)} />
        <input placeholder="Depth (1-3)" type="number" min={1} max={3} value={depth} onChange={e => setDepth(Number(e.target.value))} />
        <button onClick={handleCreate} disabled={creating || !target.trim()}>
          {creating ? 'Starting…' : 'Start Extension Scan'}
        </button>
      </div>
      <p className="scan-extension-hint">Use the InstaRL browser extension in your logged-in Instagram tab. Open each Following list when prompted; cookies stay in the browser.</p>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <h2 style={{ margin: 0 }}>Scan History</h2>
        {scans.length > 0 && (
          <button className="btn-danger" onClick={handleClearAll} disabled={clearing}>
            {clearing ? 'Clearing…' : '🗑 Clear All Data'}
          </button>
        )}
      </div>

      {scans.length === 0 ? (
        <p className="muted">No scans yet</p>
      ) : (
        <ul className="scan-list">
          {scans.map(scan => (
            <li key={scan.id} className={`scan-item status-${scan.status}`}>
              <div className="scan-row-main">
                <span className="scan-icon">{STATUS_ICON[scan.status]}</span>
                <span className="scan-target">@{scan.target}</span>
                <span className="scan-meta">
                  d{scan.depth} · {scan.users_seen} users · {scan.edges_seen} links
                  {scan.errors > 0 && ` · ${scan.errors} err`}
                  {isActiveScan(scan.status) && ` · ${scan.pending_queue_size} queued`}
                </span>
                <span className="scan-time">{fmtRelative(scan.started_at)}</span>
                <button
                  className="btn-delete-scan"
                  title="Delete this scan"
                  onClick={() => handleDelete(scan.id)}
                >×</button>
              </div>
              {isActiveScan(scan.status) && (
                <div className="scan-progress" aria-label={`Scan progress for ${scan.target}`}>
                  <div className="scan-progress-bar" />
                  <span>
                    Scanning… {scan.users_seen} accounts processed, {scan.edges_seen} relationships saved
                    {scan.pending_queue_size > 0 && `, ${scan.pending_queue_size} queued`}
                  </span>
                </div>
              )}
              {scan.errors > 0 && (
                <button className="scan-errors-toggle" onClick={() => toggleScanErrors(scan)}>
                  {scanDetails[scan.id] ? 'Hide scan errors' : 'Show scan errors'}
                </button>
              )}
              {scanDetails[scan.id]?.recent_errors.map(error => (
                <p className="scan-error" key={error.id}>
                  @{error.username ?? scan.target}: {error.error_type.replace(/_/g, ' ')} — {error.message}
                </p>
              ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
