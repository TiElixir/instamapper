const BASE = import.meta.env.VITE_API_URL ?? '/api'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`API ${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

// ─── types ────────────────────────────────────────────────────────────────────

export type AccountStatus = 'available' | 'unavailable' | 'private' | 'rate_limited' | 'blocked' | 'error'
export type RelationshipType = 'follows' | 'followed_by'
export type ScanStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface GraphNode {
  id: string
  username: string
  instagram_id?: string
  follower_count?: number
  following_count?: number
  post_count?: number
  verified: boolean
  is_private: boolean
  status: AccountStatus
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  relationship_type: RelationshipType
  mutual: boolean
  first_seen_at?: string
  last_seen_at?: string
  observation_count: number
}

export interface GraphResponse {
  nodes: GraphNode[]
  edges: GraphEdge[]
  node_count: number
  edge_count: number
  filters: Record<string, unknown>
}

export interface UserOut {
  username: string
  instagram_id?: string
  display_name?: string
  bio?: string
  follower_count?: number
  following_count?: number
  post_count?: number
  verified: boolean
  is_private: boolean
  website?: string
  picture_url?: string
  category?: string
  status: AccountStatus
  first_seen_at?: string
  last_seen_at?: string
  snapshot_count: number
}

export interface ScanSummary {
  id: number
  target: string
  depth: number
  status: ScanStatus
  started_at?: string
  finished_at?: string
  users_seen: number
  edges_seen: number
  errors: number
  pending_queue_size: number
}

export interface ScanDetail extends ScanSummary {
  error_summary: Record<string, number>
  recent_errors: Array<{ id: number; username?: string; error_type: string; message: string; occurred_at?: string }>
}

export interface ScanCreateRequest {
  target: string
  depth?: number
  cookie_path?: string
  resume?: boolean
}

export interface ExtensionScanRequest {
  target: string
  depth?: number
}

export interface CookieTestResult {
  valid: boolean
  username?: string
  detail: string
}

// ─── API calls ────────────────────────────────────────────────────────────────

export const api = {
  health: () => request<{ status: string; version: string }>('/health'),

  // Graph
  getGraph: (params?: {
    verified_only?: boolean
    hide_private?: boolean
    min_followers?: number
    only_connected?: boolean
    limit_nodes?: number
  }) => {
    const q = new URLSearchParams()
    if (params?.verified_only) q.set('verified_only', 'true')
    if (params?.hide_private) q.set('hide_private', 'true')
    if (params?.min_followers != null) q.set('min_followers', String(params.min_followers))
    if (params?.only_connected) q.set('only_connected', 'true')
    if (params?.limit_nodes != null) q.set('limit_nodes', String(params.limit_nodes))
    const qs = q.toString()
    return request<GraphResponse>(`/graph${qs ? '?' + qs : ''}`)
  },

  // Users
  getUsers: (query?: string, limit = 100) => {
    const q = new URLSearchParams({ limit: String(limit) })
    if (query) q.set('q', query)
    return request<UserOut[]>(`/users?${q}`)
  },
  getUser: (username: string) => request<UserOut>(`/users/${username}`),

  // Scans
  listScans: () => request<ScanSummary[]>('/scans'),
  getScan: (id: number) => request<ScanDetail>(`/scans/${id}`),
  createExtensionScan: (body: ExtensionScanRequest) =>
    request<{ scan_id: number; status: ScanStatus; target: string; depth: number }>('/extension/scans', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  testCookies: (cookiePath?: string) =>
    request<CookieTestResult>('/scans/test-cookies', {
      method: 'POST',
      body: JSON.stringify(cookiePath ? { cookie_path: cookiePath } : {}),
    }),
  cancelScan: (id: number) => request<ScanDetail>(`/scans/${id}/cancel`, { method: 'POST' }),
  deleteScan: (id: number) => request<{ deleted: boolean; scan_id: number }>(`/scans/${id}`, { method: 'DELETE' }),
  clearAllData: () => request<{ cleared: boolean; deleted_counts: Record<string, number> }>('/scans', { method: 'DELETE' }),

  // Exports
  exportUrl: (format: 'json' | 'csv') => `${BASE}/exports/${format}`,
}
