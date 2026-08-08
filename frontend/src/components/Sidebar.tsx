import { useEffect, useState } from 'react'
import type { GraphFilters } from '../hooks/useGraph'
import type { UserOut } from '../api/client'
import { api } from '../api/client'
import { fmtCount, fmtDate } from '../lib/formatters'

interface Props {
  filters: GraphFilters
  onFiltersChange: (patch: Partial<GraphFilters>) => void
  selectedUser: string | null
  nodeCount: number
  edgeCount: number
}

const NODE_PRESETS = [
  { label: '50', value: 50 },
  { label: '100', value: 100 },
  { label: '200', value: 200 },
  { label: '500', value: 500 },
  { label: 'All', value: undefined },
]

export default function Sidebar({ filters, onFiltersChange, selectedUser, nodeCount, edgeCount }: Props) {
  const [userDetail, setUserDetail] = useState<UserOut | null>(null)

  useEffect(() => {
    if (!selectedUser) {
      setUserDetail(null)
      return
    }
    let active = true
    api.getUser(selectedUser)
      .then(user => { if (active) setUserDetail(user) })
      .catch(() => { if (active) setUserDetail(null) })
    return () => { active = false }
  }, [selectedUser])

  return (
    <aside className="sidebar">
      <h2>Performance</h2>
      <div className="filter-group">
        <label className="filter-label">Max nodes</label>
        <div className="preset-row">
          {NODE_PRESETS.map(p => (
            <button
              key={p.label}
              className={`preset-btn ${filters.limit_nodes === p.value ? 'active' : ''}`}
              onClick={() => onFiltersChange({ limit_nodes: p.value })}
            >
              {p.label}
            </button>
          ))}
        </div>
        <label className="filter-label" style={{ marginTop: 6 }}>
          Custom
          <input
            type="number" min={10} max={5000} step={10}
            value={filters.limit_nodes ?? ''}
            onChange={e => onFiltersChange({ limit_nodes: e.target.value ? Number(e.target.value) : undefined })}
            placeholder="no limit"
          />
        </label>
      </div>

      <label>
        <input type="checkbox" checked={filters.only_connected} onChange={e => onFiltersChange({ only_connected: e.target.checked })} />
        Connected only
      </label>

      <h2>Filters</h2>
      <label>
        <input type="checkbox" checked={filters.verified_only} onChange={e => onFiltersChange({ verified_only: e.target.checked })} />
        Verified only
      </label>
      <label>
        <input type="checkbox" checked={filters.hide_private} onChange={e => onFiltersChange({ hide_private: e.target.checked })} />
        Hide private
      </label>
      <label>
        Min followers
        <input
          type="number" min={0} step={100}
          value={filters.min_followers ?? ''}
          onChange={e => onFiltersChange({ min_followers: e.target.value ? Number(e.target.value) : undefined })}
          placeholder="0"
        />
      </label>

      <div className="stats">
        <span>{nodeCount} nodes</span>
        <span>{edgeCount} edges</span>
      </div>

      {userDetail && (
        <>
          <h2>@{userDetail.username}</h2>
          <ul className="user-detail">
            {userDetail.display_name && <li>{userDetail.display_name}</li>}
            <li>Followers: {fmtCount(userDetail.follower_count)}</li>
            <li>Following: {fmtCount(userDetail.following_count)}</li>
            <li>Posts: {fmtCount(userDetail.post_count)}</li>
            {userDetail.verified && <li>✓ Verified</li>}
            {userDetail.is_private && <li>🔒 Private</li>}
            {userDetail.bio && <li className="bio">{userDetail.bio}</li>}
            <li>First seen: {fmtDate(userDetail.first_seen_at)}</li>
            <li>Snapshots: {userDetail.snapshot_count}</li>
          </ul>
        </>
      )}

      <h2>Export</h2>
      <div className="export-buttons">
        <a href={api.exportUrl('json')} download>JSON</a>
        <a href={api.exportUrl('csv')} download>CSV</a>
      </div>
    </aside>
  )
}
