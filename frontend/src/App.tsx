import { ChangeEvent, useRef, useState } from 'react'
import GraphView from './components/GraphView'
import Sidebar from './components/Sidebar'
import ScanPanel from './components/ScanPanel'
import SearchBar from './components/SearchBar'
import Header from './components/Header'
import { useDarkMode } from './hooks/useDarkMode'
import { GraphResponse } from './api/client'
import { useGraph } from './hooks/useGraph'

function normalizeImportedGraph(payload: any): GraphResponse {
  const rawNodes = Array.isArray(payload?.nodes) ? payload.nodes : []
  const rawEdges = Array.isArray(payload?.edges) ? payload.edges : []
  const nodes = rawNodes.map((node: any) => ({
    id: String(node.id || node.username || ''),
    username: String(node.username || node.id || '').toLowerCase(),
    instagram_id: node.instagram_id ?? undefined,
    follower_count: node.follower_count ?? undefined,
    following_count: node.following_count ?? undefined,
    post_count: node.post_count ?? undefined,
    verified: Boolean(node.verified),
    is_private: Boolean(node.is_private),
    status: node.status || 'available',
  })).filter((node: any) => node.username)
  const edges = rawEdges.map((edge: any, index: number) => ({
    id: String(edge.id || `${edge.source}->${edge.target}:${index}`),
    source: String(edge.source || '').toLowerCase(),
    target: String(edge.target || '').toLowerCase(),
    relationship_type: edge.relationship_type || 'follows',
    mutual: Boolean(edge.mutual),
    first_seen_at: edge.first_seen_at ?? undefined,
    last_seen_at: edge.last_seen_at ?? undefined,
    observation_count: Number(edge.observation_count || 1),
  })).filter((edge: any) => edge.source && edge.target)
  return {
    nodes,
    edges,
    node_count: nodes.length,
    edge_count: edges.length,
    filters: { imported: true, ...(payload?.filters || {}) },
  }
}

export default function App() {
  const [dark, setDark] = useDarkMode()
  const [tab, setTab] = useState<'graph' | 'scans'>('graph')
  const [search, setSearch] = useState('')
  const [selectedUser, setSelectedUser] = useState<string | null>(null)
  const [importedGraph, setImportedGraph] = useState<GraphResponse | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { data, loading, error, filters, updateFilters, reload } = useGraph()
  const graphData = importedGraph ?? data
  const graphError = importError ?? error

  const handleImportJson = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setImportError(null)
    try {
      const parsed = JSON.parse(await file.text())
      setImportedGraph(normalizeImportedGraph(parsed))
      setSelectedUser(null)
      setSearch('')
    } catch (err: any) {
      setImportError(err?.message ? `Import failed: ${err.message}` : 'Import failed: invalid JSON')
    }
  }

  const handleReloadBackendGraph = () => {
    setImportedGraph(null)
    setImportError(null)
    reload()
  }

  return (
    <div className={`app ${dark ? 'dark' : 'light'}`}>
      <Header dark={dark} onToggleDark={() => setDark(!dark)} activeTab={tab} onTabChange={setTab} />

      {tab === 'graph' ? (
        <div className="main-layout">
          <div className="graph-pane">
            <SearchBar onSearch={setSearch} />
            <div className="graph-import-bar">
              <input ref={fileInputRef} type="file" accept="application/json,.json" onChange={handleImportJson} hidden />
              <button onClick={() => fileInputRef.current?.click()}>Import JSON</button>
              {importedGraph && <button onClick={handleReloadBackendGraph}>Back to backend graph</button>}
              {importedGraph && <span>Imported {importedGraph.node_count} nodes / {importedGraph.edge_count} edges</span>}
            </div>
            {loading && !importedGraph && <div className="loading">Loading graph…</div>}
            {graphError && <div className="error">{graphError}</div>}
            {graphData && !loading && graphData.nodes.length === 0 && (
              <div className="empty">
                No data yet. Run a scan or import a graph JSON file.
              </div>
            )}
            {graphData && graphData.nodes.length > 0 && (
              <GraphView data={graphData} searchQuery={search} onSelectNode={setSelectedUser} />
            )}
          </div>
          <Sidebar
            filters={filters}
            onFiltersChange={updateFilters}
            selectedUser={selectedUser}
            nodeCount={graphData?.node_count ?? 0}
            edgeCount={graphData?.edge_count ?? 0}
          />
        </div>
      ) : (
        <ScanPanel onScanComplete={reload} />
      )}
    </div>
  )
}
