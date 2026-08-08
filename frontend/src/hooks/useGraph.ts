import { useCallback, useEffect, useState } from 'react'
import { api, GraphResponse } from '../api/client'

export interface GraphFilters {
  verified_only: boolean
  hide_private: boolean
  min_followers?: number
  only_connected: boolean
  limit_nodes?: number
}

const defaultFilters: GraphFilters = {
  verified_only: false,
  hide_private: false,
  only_connected: true,
  limit_nodes: 200,
}

export function useGraph() {
  const [data, setData] = useState<GraphResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filters, setFilters] = useState<GraphFilters>(defaultFilters)

  const loadGraph = useCallback(async (f: GraphFilters = filters) => {
    setLoading(true)
    setError(null)
    try {
      const resp = await api.getGraph(f)
      setData(resp)
    } catch (err: any) {
      setError(err.message ?? 'failed to load graph')
    } finally {
      setLoading(false)
    }
  }, [filters])

  useEffect(() => { loadGraph() }, [])

  const updateFilters = useCallback((patch: Partial<GraphFilters>) => {
    const next = { ...filters, ...patch }
    setFilters(next)
    loadGraph(next)
  }, [filters, loadGraph])

  return { data, loading, error, filters, updateFilters, reload: () => loadGraph(filters) }
}
