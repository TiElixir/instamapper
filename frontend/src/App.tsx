import { useState } from 'react'
import GraphView from './components/GraphView'
import Sidebar from './components/Sidebar'
import ScanPanel from './components/ScanPanel'
import SearchBar from './components/SearchBar'
import Header from './components/Header'
import { useDarkMode } from './hooks/useDarkMode'
import { useGraph } from './hooks/useGraph'

export default function App() {
  const [dark, setDark] = useDarkMode()
  const [tab, setTab] = useState<'graph' | 'scans'>('graph')
  const [search, setSearch] = useState('')
  const [selectedUser, setSelectedUser] = useState<string | null>(null)
  const { data, loading, error, filters, updateFilters, reload } = useGraph()

  return (
    <div className={`app ${dark ? 'dark' : 'light'}`}>
      <Header dark={dark} onToggleDark={() => setDark(!dark)} activeTab={tab} onTabChange={setTab} />

      {tab === 'graph' ? (
        <div className="main-layout">
          <div className="graph-pane">
            <SearchBar onSearch={setSearch} />
            {loading && <div className="loading">Loading graph…</div>}
            {error && <div className="error">{error}</div>}
            {data && !loading && data.nodes.length === 0 && (
              <div className="empty">
                No data yet. Run a scan to populate the graph.
              </div>
            )}
            {data && data.nodes.length > 0 && (
              <GraphView data={data} searchQuery={search} onSelectNode={setSelectedUser} />
            )}
          </div>
          <Sidebar
            filters={filters}
            onFiltersChange={updateFilters}
            selectedUser={selectedUser}
            nodeCount={data?.node_count ?? 0}
            edgeCount={data?.edge_count ?? 0}
          />
        </div>
      ) : (
        <ScanPanel onScanComplete={reload} />
      )}
    </div>
  )
}
